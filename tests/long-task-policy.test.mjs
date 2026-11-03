import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getLongTaskPolicy,
  resolveAgentBudgets,
} from '../skills/deepseek-collaboration/scripts/deepseek-long-task-policy.mjs';

const DISABLED_DEFAULTS = Object.freeze({
  enabled: false,
  output_tokens: 'explicit',
  request_timeout_ms: 180000,
  request_total_timeout_ms: 360000,
  task_timeout_ms: 360000,
  initial_steps: 12,
  initial_tool_calls: 24,
});

const ENABLED_DEFAULTS = Object.freeze({
  enabled: true,
  output_tokens: 'route_max',
  request_timeout_ms: 900000,
  request_total_timeout_ms: 1800000,
  task_timeout_ms: 7200000,
  initial_steps: 64,
  initial_tool_calls: 256,
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectTypeError(run, message) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof TypeError);
    if (message !== undefined) {
      assert.match(error.message, message);
    }
    return true;
  });
}

function errorMessage(run) {
  try {
    run();
  } catch (error) {
    return error.message;
  }
  assert.fail('expected the operation to throw');
}

test('missing long_task_policy returns the exact legacy disabled policy', () => {
  assert.deepEqual(getLongTaskPolicy(), DISABLED_DEFAULTS);
  assert.deepEqual(getLongTaskPolicy({}), DISABLED_DEFAULTS);
  assert.deepEqual(
    getLongTaskPolicy({ unrelated: 'ignored', mode: 'legacy' }),
    DISABLED_DEFAULTS,
  );

  const first = getLongTaskPolicy();
  const second = getLongTaskPolicy();
  assert.notStrictEqual(first, second);
  first.enabled = true;
  first.initial_steps = 9999;
  assert.deepEqual(second, DISABLED_DEFAULTS);
  assert.deepEqual(getLongTaskPolicy(), DISABLED_DEFAULTS);
});

test('enabled policy opts into the documented long-task defaults', () => {
  const rawPolicy = { enabled: true };
  const config = { long_task_policy: rawPolicy, unrelated: 'ignored' };
  const before = clone(config);

  const policy = getLongTaskPolicy(config);

  assert.deepEqual(policy, ENABLED_DEFAULTS);
  assert.notStrictEqual(policy, rawPolicy);
  assert.deepEqual(config, before);
});

test('disabled custom policy is normalized but resolution keeps legacy budgets', () => {
  const rawPolicy = {
    enabled: false,
    output_tokens: 'route_max',
    request_timeout_ms: 1000,
    request_total_timeout_ms: 2500,
    task_timeout_ms: 5000,
    initial_steps: 7,
    initial_tool_calls: 9,
  };
  const policy = getLongTaskPolicy({ long_task_policy: rawPolicy });

  assert.deepEqual(policy, rawPolicy);
  assert.deepEqual(
    resolveAgentBudgets({ policy, routeMaxOutputTokens: 50000 }),
    {
      maxOutputTokens: 4096,
      maxSteps: 12,
      maxToolCalls: 24,
      totalTimeoutMs: 360000,
      requestTimeoutMs: 180000,
      requestTotalTimeoutMs: 360000,
      unlimitedCumulativeBudgets: false,
    },
  );

  expectTypeError(
    () => getLongTaskPolicy({
      long_task_policy: {
        enabled: false,
        request_timeout_ms: 5000,
        request_total_timeout_ms: 4000,
      },
    }),
    /request_total_timeout_ms/,
  );
});

test('enabled custom policy supplies defaults and explicit arguments override them', () => {
  const policy = getLongTaskPolicy({
    long_task_policy: {
      enabled: true,
      output_tokens: 'explicit',
      request_timeout_ms: 1000,
      request_total_timeout_ms: 2500,
      task_timeout_ms: 8000,
      initial_steps: 7,
      initial_tool_calls: 9,
    },
  });

  assert.deepEqual(
    resolveAgentBudgets({ policy, routeMaxOutputTokens: 20000 }),
    {
      maxOutputTokens: 4096,
      maxSteps: 7,
      maxToolCalls: 9,
      totalTimeoutMs: 8000,
      requestTimeoutMs: 1000,
      requestTotalTimeoutMs: 2500,
      unlimitedCumulativeBudgets: true,
    },
  );

  assert.deepEqual(
    resolveAgentBudgets({
      policy,
      routeMaxOutputTokens: 20000,
      maxOutputTokens: 15000,
      maxSteps: 11,
      maxToolCalls: 13,
      totalTimeoutMs: 9000,
    }),
    {
      maxOutputTokens: 15000,
      maxSteps: 11,
      maxToolCalls: 13,
      totalTimeoutMs: 9000,
      requestTimeoutMs: 1000,
      requestTotalTimeoutMs: 2500,
      unlimitedCumulativeBudgets: true,
    },
  );
});

test('policy boundaries at both ends of every constrained field are accepted', () => {
  const upper = getLongTaskPolicy({
    long_task_policy: {
      enabled: true,
      request_timeout_ms: 86400000,
      request_total_timeout_ms: 86400000,
      task_timeout_ms: 86400000,
      initial_steps: 4096,
      initial_tool_calls: 16384,
    },
  });
  assert.equal(upper.request_timeout_ms, 86400000);
  assert.equal(upper.request_total_timeout_ms, 86400000);
  assert.equal(upper.task_timeout_ms, 86400000);
  assert.equal(upper.initial_steps, 4096);
  assert.equal(upper.initial_tool_calls, 16384);

  const lower = getLongTaskPolicy({
    long_task_policy: {
      enabled: true,
      request_timeout_ms: 1,
      request_total_timeout_ms: 1,
      task_timeout_ms: 1,
      initial_steps: 1,
      initial_tool_calls: 1,
    },
  });
  assert.equal(lower.request_timeout_ms, 1);
  assert.equal(lower.request_total_timeout_ms, 1);
  assert.equal(lower.task_timeout_ms, 1);
  assert.equal(lower.initial_steps, 1);
  assert.equal(lower.initial_tool_calls, 1);

  assert.deepEqual(
    resolveAgentBudgets({
      policy: upper,
      routeMaxOutputTokens: 393216,
    }),
    {
      maxOutputTokens: 393216,
      maxSteps: 4096,
      maxToolCalls: 16384,
      totalTimeoutMs: 86400000,
      requestTimeoutMs: 86400000,
      requestTotalTimeoutMs: 86400000,
      unlimitedCumulativeBudgets: true,
    },
  );
});

test('policy rejects invalid types, fractional values, zero, and safe-integer overflow', () => {
  const invalidPolicies = [
    { enabled: true, output_tokens: 'sometimes' },
    { enabled: true, output_tokens: null },
    { enabled: true, request_timeout_ms: 0 },
    { enabled: true, request_timeout_ms: 86400001 },
    { enabled: true, request_timeout_ms: 1.5 },
    { enabled: true, request_timeout_ms: '1000' },
    { enabled: true, request_total_timeout_ms: 0 },
    { enabled: true, request_total_timeout_ms: 86400001 },
    { enabled: true, task_timeout_ms: 0 },
    { enabled: true, task_timeout_ms: Number.NaN },
    { enabled: true, task_timeout_ms: Number.MAX_SAFE_INTEGER + 1 },
    { enabled: true, initial_steps: 0 },
    { enabled: true, initial_steps: 4097 },
    { enabled: true, initial_steps: 1.25 },
    { enabled: true, initial_tool_calls: 0 },
    { enabled: true, initial_tool_calls: 16385 },
    { enabled: true, initial_tool_calls: Number.MAX_SAFE_INTEGER + 1 },
  ];

  for (const long_task_policy of invalidPolicies) {
    expectTypeError(() => getLongTaskPolicy({ long_task_policy }));
  }
});

test('max output uses route max only for enabled route_max policies', () => {
  const routeMaxPolicy = getLongTaskPolicy({
    long_task_policy: { enabled: true, output_tokens: 'route_max' },
  });
  const explicitPolicy = getLongTaskPolicy({
    long_task_policy: { enabled: true, output_tokens: 'explicit' },
  });
  const disabledPolicy = getLongTaskPolicy();

  assert.equal(
    resolveAgentBudgets({
      policy: routeMaxPolicy,
      routeMaxOutputTokens: 12345,
    }).maxOutputTokens,
    12345,
  );
  assert.equal(
    resolveAgentBudgets({
      policy: explicitPolicy,
      routeMaxOutputTokens: 8192,
    }).maxOutputTokens,
    4096,
  );
  assert.equal(
    resolveAgentBudgets({
      policy: explicitPolicy,
      routeMaxOutputTokens: 8192,
      maxOutputTokens: 5000,
    }).maxOutputTokens,
    5000,
  );
  assert.equal(
    resolveAgentBudgets({
      policy: routeMaxPolicy,
      routeMaxOutputTokens: 8192,
      maxOutputTokens: 7000,
    }).maxOutputTokens,
    7000,
  );
  assert.equal(
    resolveAgentBudgets({
      policy: routeMaxPolicy,
      routeMaxOutputTokens: 8192,
      maxOutputTokens: undefined,
    }).maxOutputTokens,
    8192,
  );

  expectTypeError(
    () => resolveAgentBudgets({
      policy: explicitPolicy,
      routeMaxOutputTokens: 1000,
    }),
    /default/,
  );
  expectTypeError(
    () => resolveAgentBudgets({
      policy: disabledPolicy,
      routeMaxOutputTokens: 1000,
    }),
    /default/,
  );
  assert.equal(
    resolveAgentBudgets({
      policy: disabledPolicy,
      routeMaxOutputTokens: 1000,
      maxOutputTokens: 1000,
    }).maxOutputTokens,
    1000,
  );
});

test('route cap and explicit max output validate bounds and ordering', () => {
  const policy = getLongTaskPolicy({
    long_task_policy: { enabled: true, output_tokens: 'route_max' },
  });

  for (const routeMaxOutputTokens of [
    31,
    393217,
    0,
    Number.NaN,
    null,
    1.5,
    '4096',
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expectTypeError(() => resolveAgentBudgets({ policy, routeMaxOutputTokens }));
  }

  assert.equal(
    resolveAgentBudgets({ policy, routeMaxOutputTokens: 32 }).maxOutputTokens,
    32,
  );
  assert.equal(
    resolveAgentBudgets({
      policy,
      routeMaxOutputTokens: 393216,
    }).maxOutputTokens,
    393216,
  );
  assert.equal(
    resolveAgentBudgets({
      policy,
      routeMaxOutputTokens: 393216,
      maxOutputTokens: 393216,
    }).maxOutputTokens,
    393216,
  );

  for (const maxOutputTokens of [
    31,
    393217,
    0,
    Number.NaN,
    null,
    1.5,
    '4096',
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expectTypeError(
      () => resolveAgentBudgets({
        policy,
        routeMaxOutputTokens: 393216,
        maxOutputTokens,
      }),
    );
  }

  expectTypeError(
    () => resolveAgentBudgets({
      policy,
      routeMaxOutputTokens: 8000,
      maxOutputTokens: 8001,
    }),
    /exceed/,
  );
});

test('enabled explicit step, tool, and timeout overrides enforce long-task caps', () => {
  const policy = getLongTaskPolicy({
    long_task_policy: { enabled: true },
  });
  const base = { policy, routeMaxOutputTokens: 8192 };

  assert.equal(
    resolveAgentBudgets({ ...base, maxSteps: 1 }).maxSteps,
    1,
  );
  assert.equal(
    resolveAgentBudgets({ ...base, maxSteps: 4096 }).maxSteps,
    4096,
  );
  assert.equal(
    resolveAgentBudgets({ ...base, maxToolCalls: 1 }).maxToolCalls,
    1,
  );
  assert.equal(
    resolveAgentBudgets({ ...base, maxToolCalls: 16384 }).maxToolCalls,
    16384,
  );
  assert.equal(
    resolveAgentBudgets({ ...base, totalTimeoutMs: 1 }).totalTimeoutMs,
    1,
  );
  assert.equal(
    resolveAgentBudgets({
      ...base,
      totalTimeoutMs: 86400000,
    }).totalTimeoutMs,
    86400000,
  );

  for (const maxSteps of [0, 4097, 1.5, Number.NaN, null, '8']) {
    expectTypeError(() => resolveAgentBudgets({ ...base, maxSteps }));
  }
  for (const maxToolCalls of [0, 16385, 1.5, Number.NaN, null, '8']) {
    expectTypeError(() => resolveAgentBudgets({ ...base, maxToolCalls }));
  }
  for (const totalTimeoutMs of [
    0,
    86400001,
    1.5,
    Number.NaN,
    null,
    '1000',
  ]) {
    expectTypeError(() => resolveAgentBudgets({ ...base, totalTimeoutMs }));
  }
});

test('disabled explicit overrides retain the tighter legacy caps', () => {
  const policy = getLongTaskPolicy();
  const base = { policy, routeMaxOutputTokens: 4096 };

  assert.deepEqual(
    resolveAgentBudgets({
      ...base,
      maxOutputTokens: 4096,
      maxSteps: 12,
      maxToolCalls: 32,
      totalTimeoutMs: 900000,
    }),
    {
      maxOutputTokens: 4096,
      maxSteps: 12,
      maxToolCalls: 32,
      totalTimeoutMs: 900000,
      requestTimeoutMs: 180000,
      requestTotalTimeoutMs: 360000,
      unlimitedCumulativeBudgets: false,
    },
  );

  for (const maxSteps of [0, 13, 1.5, Number.NaN, null]) {
    expectTypeError(() => resolveAgentBudgets({ ...base, maxSteps }));
  }
  for (const maxToolCalls of [0, 33, 1.5, Number.NaN, null]) {
    expectTypeError(() => resolveAgentBudgets({ ...base, maxToolCalls }));
  }
  for (const totalTimeoutMs of [0, 900001, 1.5, Number.NaN, null]) {
    expectTypeError(() => resolveAgentBudgets({ ...base, totalTimeoutMs }));
  }
});

test('0, NaN, and null are values rather than omitted optional arguments', () => {
  const enabledPolicy = getLongTaskPolicy({
    long_task_policy: { enabled: true, output_tokens: 'route_max' },
  });
  const disabledPolicy = getLongTaskPolicy();

  for (const policy of [enabledPolicy, disabledPolicy]) {
    for (const value of [0, Number.NaN, null]) {
      const base = { policy, routeMaxOutputTokens: 8192 };
      expectTypeError(
        () => resolveAgentBudgets({ ...base, maxOutputTokens: value }),
      );
      expectTypeError(
        () => resolveAgentBudgets({ ...base, maxSteps: value }),
      );
      expectTypeError(
        () => resolveAgentBudgets({ ...base, maxToolCalls: value }),
      );
      expectTypeError(
        () => resolveAgentBudgets({ ...base, totalTimeoutMs: value }),
      );
    }
  }
});

test('malformed config and malformed policy roots fail with TypeError', () => {
  for (const config of [null, [], new Date(), 'config', 1, true]) {
    expectTypeError(() => getLongTaskPolicy(config));
  }
  for (const long_task_policy of [
    null,
    [],
    new Date(),
    new Map(),
    'policy',
    1,
    true,
    undefined,
  ]) {
    expectTypeError(() => getLongTaskPolicy({ long_task_policy }));
  }

  expectTypeError(
    () => getLongTaskPolicy({ long_task_policy: {} }),
    /enabled/,
  );
  for (const enabled of ['true', 1, null, undefined, 0]) {
    expectTypeError(
      () => getLongTaskPolicy({ long_task_policy: { enabled } }),
      /enabled/,
    );
  }
});

test('unknown policy keys are rejected, including symbols and hidden keys', () => {
  const unknownStringKey = { enabled: true, TOPSECRET_KEY: 'TOPSECRET_VALUE' };
  const unknownSymbol = { enabled: true };
  unknownSymbol[Symbol('TOPSECRET_SYMBOL')] = 'TOPSECRET_VALUE';
  const hiddenKey = { enabled: true };
  Object.defineProperty(hiddenKey, 'TOPSECRET_HIDDEN', {
    configurable: true,
    enumerable: false,
    value: 'TOPSECRET_VALUE',
  });

  for (const policy of [unknownStringKey, unknownSymbol, hiddenKey]) {
    expectTypeError(
      () => getLongTaskPolicy({ long_task_policy: policy }),
      /unknown keys/,
    );
  }
});

test('resolveAgentBudgets validates forged and mutated normalized policies', () => {
  assert.deepEqual(
    resolveAgentBudgets({
      policy: { enabled: true },
      routeMaxOutputTokens: 8192,
    }),
    {
      maxOutputTokens: 8192,
      maxSteps: 64,
      maxToolCalls: 256,
      totalTimeoutMs: 7200000,
      requestTimeoutMs: 900000,
      requestTotalTimeoutMs: 1800000,
      unlimitedCumulativeBudgets: true,
    },
  );

  const policy = getLongTaskPolicy({
    long_task_policy: { enabled: true },
  });

  expectTypeError(
    () => resolveAgentBudgets({
      policy: { ...policy, unexpected: true },
      routeMaxOutputTokens: 8192,
    }),
    /unknown keys/,
  );

  const withoutEnabled = { ...policy };
  delete withoutEnabled.enabled;
  expectTypeError(
    () => resolveAgentBudgets({
      policy: withoutEnabled,
      routeMaxOutputTokens: 8192,
    }),
    /enabled/,
  );

  expectTypeError(
    () => resolveAgentBudgets({
      policy: {
        ...policy,
        request_total_timeout_ms: policy.request_timeout_ms - 1,
      },
      routeMaxOutputTokens: 8192,
    }),
    /request_total_timeout_ms/,
  );

  expectTypeError(
    () => resolveAgentBudgets({
      policy: { ...policy, initial_steps: 4097 },
      routeMaxOutputTokens: 8192,
    }),
  );
});

test('policy and arguments are not mutated, even when deeply frozen', () => {
  const rawPolicy = Object.freeze({
    enabled: true,
    request_timeout_ms: 1000,
    request_total_timeout_ms: 3000,
    task_timeout_ms: 4000,
    initial_steps: 8,
    initial_tool_calls: 10,
  });
  const config = Object.freeze({ long_task_policy: rawPolicy });
  const beforePolicy = clone(rawPolicy);

  const policy = getLongTaskPolicy(config);
  const policySnapshot = clone(policy);
  assert.deepEqual(rawPolicy, beforePolicy);

  const argumentsObject = Object.freeze({
    policy: Object.freeze({ ...policy }),
    routeMaxOutputTokens: 8192,
    maxSteps: 6,
    maxToolCalls: 7,
    totalTimeoutMs: 5000,
  });
  const beforeArguments = clone(argumentsObject);
  const result = resolveAgentBudgets(argumentsObject);

  assert.deepEqual(policy, policySnapshot);
  assert.deepEqual(argumentsObject, beforeArguments);
  assert.notStrictEqual(result, policy);
  result.maxSteps = 999;
  assert.equal(argumentsObject.maxSteps, 6);
});

test('error messages are fixed and never echo unknown keys or supplied values', () => {
  const unknownOne = errorMessage(() => getLongTaskPolicy({
    long_task_policy: { enabled: true, TOPSECRET_KEY_ONE: 'TOPSECRET_VALUE_ONE' },
  }));
  const unknownTwo = errorMessage(() => getLongTaskPolicy({
    long_task_policy: { enabled: true, TOPSECRET_KEY_TWO: 'TOPSECRET_VALUE_TWO' },
  }));
  assert.equal(unknownOne, unknownTwo);
  assert.ok(!unknownOne.includes('TOPSECRET'));

  const enabledOne = errorMessage(() => getLongTaskPolicy({
    long_task_policy: { enabled: 'TOPSECRET_VALUE_ONE' },
  }));
  const enabledTwo = errorMessage(() => getLongTaskPolicy({
    long_task_policy: { enabled: 'TOPSECRET_VALUE_TWO' },
  }));
  assert.equal(enabledOne, enabledTwo);
  assert.ok(!enabledOne.includes('TOPSECRET'));

  const outputOne = errorMessage(() => getLongTaskPolicy({
    long_task_policy: { enabled: true, output_tokens: 'TOPSECRET_VALUE_ONE' },
  }));
  const outputTwo = errorMessage(() => getLongTaskPolicy({
    long_task_policy: { enabled: true, output_tokens: 'TOPSECRET_VALUE_TWO' },
  }));
  assert.equal(outputOne, outputTwo);
  assert.ok(!outputOne.includes('TOPSECRET'));
});
