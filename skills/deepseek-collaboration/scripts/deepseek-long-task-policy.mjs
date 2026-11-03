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

const POLICY_KEYS = new Set([
  'enabled',
  'output_tokens',
  'request_timeout_ms',
  'request_total_timeout_ms',
  'task_timeout_ms',
  'initial_steps',
  'initial_tool_calls',
]);

const ERRORS = Object.freeze({
  config: 'config must be a plain object',
  policy: 'long_task_policy must be a plain object',
  arguments: 'arguments must be a plain object',
  unknown: 'long_task_policy contains unknown keys',
  enabled: 'long_task_policy.enabled must be a boolean',
  output: "long_task_policy.output_tokens must be 'route_max' or 'explicit'",
  requestTimeout: 'long_task_policy.request_timeout_ms must be a safe integer between 1 and 86400000',
  requestTotalTimeout: 'long_task_policy.request_total_timeout_ms must be a safe integer between 1 and 86400000',
  timeoutOrder: 'long_task_policy.request_total_timeout_ms must be greater than or equal to request_timeout_ms',
  taskTimeout: 'long_task_policy.task_timeout_ms must be a safe integer between 1 and 86400000',
  steps: 'long_task_policy.initial_steps must be a safe integer between 1 and 4096',
  tools: 'long_task_policy.initial_tool_calls must be a safe integer between 1 and 16384',
  route: 'routeMaxOutputTokens must be a safe integer between 32 and 393216',
  maxOutput: 'maxOutputTokens must be a safe integer between 32 and 393216',
  maxOutputRoute: 'maxOutputTokens must not exceed routeMaxOutputTokens',
  maxOutputDefault: 'maxOutputTokens default cannot exceed routeMaxOutputTokens',
  enabledSteps: 'maxSteps must be a safe integer between 1 and 4096',
  enabledTools: 'maxToolCalls must be a safe integer between 1 and 16384',
  enabledTimeout: 'totalTimeoutMs must be a safe integer between 1 and 86400000',
  disabledSteps: 'maxSteps must be a safe integer between 1 and 12',
  disabledTools: 'maxToolCalls must be a safe integer between 1 and 32',
  disabledTimeout: 'totalTimeoutMs must be a safe integer between 1 and 900000',
});

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message) {
  throw new TypeError(message);
}

function assertIntegerInRange(value, minimum, maximum, message) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(message);
  }
}

function assertPolicyKeys(policy) {
  for (const key of Reflect.ownKeys(policy)) {
    if (typeof key !== 'string' || !POLICY_KEYS.has(key)) {
      fail(ERRORS.unknown);
    }
  }
}

function normalizePolicy(policy) {
  if (!isPlainRecord(policy)) {
    fail(ERRORS.policy);
  }
  assertPolicyKeys(policy);

  if (!hasOwn(policy, 'enabled') || typeof policy.enabled !== 'boolean') {
    fail(ERRORS.enabled);
  }

  const enabled = policy.enabled;
  const defaults = enabled ? ENABLED_DEFAULTS : DISABLED_DEFAULTS;
  const valueFor = (key) => (hasOwn(policy, key) ? policy[key] : defaults[key]);

  const outputTokens = valueFor('output_tokens');
  if (outputTokens !== 'route_max' && outputTokens !== 'explicit') {
    fail(ERRORS.output);
  }

  const requestTimeoutMs = valueFor('request_timeout_ms');
  assertIntegerInRange(requestTimeoutMs, 1, 86400000, ERRORS.requestTimeout);

  const requestTotalTimeoutMs = valueFor('request_total_timeout_ms');
  assertIntegerInRange(requestTotalTimeoutMs, 1, 86400000, ERRORS.requestTotalTimeout);
  if (requestTotalTimeoutMs < requestTimeoutMs) {
    fail(ERRORS.timeoutOrder);
  }

  const taskTimeoutMs = valueFor('task_timeout_ms');
  assertIntegerInRange(taskTimeoutMs, 1, 86400000, ERRORS.taskTimeout);

  const initialSteps = valueFor('initial_steps');
  assertIntegerInRange(initialSteps, 1, 4096, ERRORS.steps);

  const initialToolCalls = valueFor('initial_tool_calls');
  assertIntegerInRange(initialToolCalls, 1, 16384, ERRORS.tools);

  return {
    enabled,
    output_tokens: outputTokens,
    request_timeout_ms: requestTimeoutMs,
    request_total_timeout_ms: requestTotalTimeoutMs,
    task_timeout_ms: taskTimeoutMs,
    initial_steps: initialSteps,
    initial_tool_calls: initialToolCalls,
  };
}

export function getLongTaskPolicy(config = {}) {
  if (!isPlainRecord(config)) {
    fail(ERRORS.config);
  }

  if (!hasOwn(config, 'long_task_policy')) {
    return { ...DISABLED_DEFAULTS };
  }

  return normalizePolicy(config.long_task_policy);
}

export function resolveAgentBudgets(input) {
  if (!isPlainRecord(input)) {
    fail(ERRORS.arguments);
  }

  const policy = normalizePolicy(input.policy);
  const routeMaxOutputTokens = input.routeMaxOutputTokens;
  assertIntegerInRange(routeMaxOutputTokens, 32, 393216, ERRORS.route);

  let maxOutputTokens;
  if (input.maxOutputTokens !== undefined) {
    maxOutputTokens = input.maxOutputTokens;
    assertIntegerInRange(maxOutputTokens, 32, 393216, ERRORS.maxOutput);
    if (maxOutputTokens > routeMaxOutputTokens) {
      fail(ERRORS.maxOutputRoute);
    }
  } else if (policy.enabled && policy.output_tokens === 'route_max') {
    maxOutputTokens = routeMaxOutputTokens;
  } else {
    if (routeMaxOutputTokens < 4096) {
      fail(ERRORS.maxOutputDefault);
    }
    maxOutputTokens = 4096;
  }

  let maxSteps;
  let maxToolCalls;
  let totalTimeoutMs;

  if (policy.enabled) {
    maxSteps = input.maxSteps !== undefined ? input.maxSteps : policy.initial_steps;
    maxToolCalls = input.maxToolCalls !== undefined ? input.maxToolCalls : policy.initial_tool_calls;
    totalTimeoutMs = input.totalTimeoutMs !== undefined ? input.totalTimeoutMs : policy.task_timeout_ms;

    assertIntegerInRange(maxSteps, 1, 4096, ERRORS.enabledSteps);
    assertIntegerInRange(maxToolCalls, 1, 16384, ERRORS.enabledTools);
    assertIntegerInRange(totalTimeoutMs, 1, 86400000, ERRORS.enabledTimeout);
  } else {
    maxSteps = input.maxSteps !== undefined ? input.maxSteps : 12;
    maxToolCalls = input.maxToolCalls !== undefined ? input.maxToolCalls : 24;
    totalTimeoutMs = input.totalTimeoutMs !== undefined ? input.totalTimeoutMs : 360000;

    assertIntegerInRange(maxSteps, 1, 12, ERRORS.disabledSteps);
    assertIntegerInRange(maxToolCalls, 1, 32, ERRORS.disabledTools);
    assertIntegerInRange(totalTimeoutMs, 1, 900000, ERRORS.disabledTimeout);
  }

  return {
    maxOutputTokens,
    maxSteps,
    maxToolCalls,
    totalTimeoutMs,
    requestTimeoutMs: policy.enabled ? policy.request_timeout_ms : 180000,
    requestTotalTimeoutMs: policy.enabled ? policy.request_total_timeout_ms : 360000,
    unlimitedCumulativeBudgets: policy.enabled,
  };
}
