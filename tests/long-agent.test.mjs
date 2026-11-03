// All long-task contracts run offline with synthetic credentials and a mock clock.
import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync,
  statSync, utimesSync } from 'node:fs';
import { createAgentRuntime } from '../skills/deepseek-collaboration/scripts/deepseek-agent-runtime.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 10_000 }, fn);
const tempRoot = realpathSync(tmpdir());
const credential = 'SYNTHETIC-LONG-AGENT-CREDENTIAL';
const reasoning = 'SYNTHETIC-LONG-PRIVATE-REASONING';
const routeCap = 278528;
const hour = 3_600_000;
const day = 24 * hour;
const configuration = {
  base_url: 'https://api.example.test/v1', allowed_origin: 'https://api.example.test',
  protocol: 'openai', model: 'deepseek-flash-long-test',
  models: { flash: 'deepseek-flash-long-test' }, credential_source: 'env',
  default_reasoning_effort: 'max',
  capabilities: { flash: { context_window_tokens: 1048576, max_output_tokens: routeCap } },
  output_budget_policy: { flash: { max_reasoning_min_output_tokens: 16384 } },
  long_task_policy: { enabled: true },
};
const plugin = { name: 'synthetic_lookup', description: 'Return a synthetic lookup.',
  input_schema: { type: 'object' } };
globalThis.fetch = async () => { throw new Error('Long-task tests forbid network access.'); };

function call(id, name = 'list_files', args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
function tools(...calls) {
  return { data: { choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null, tool_calls: calls, reasoning_content: reasoning,
  } }] }, metadata: { attempts: 1 } };
}
function done() {
  return { data: { choices: [{ finish_reason: 'stop', message: {
    role: 'assistant', content: 'Synthetic long task complete.', reasoning_content: reasoning,
  } }] }, metadata: { attempts: 1 } };
}
function clock(t) {
  const state = { now: 1_800_000_000_000 };
  t.mock.method(Date, 'now', () => state.now);
  return state;
}
const input = extra => ({ task: 'Complete the synthetic long task.', model: 'flash', ...extra });
const rejection = (operation, code = 'invalid_argument') => assert.rejects(operation,
  error => error?.code === code);
const hash = content => createHash('sha256').update(content).digest('hex');

function fixture(t, provider, config = configuration) {
  const root = mkdtempSync(join(tempRoot, 'codex-long-agent-test-'));
  const stateDir = join(root, 'state');
  const scratchRoot = join(root, 'scratch');
  mkdirSync(stateDir); mkdirSync(scratchRoot);
  const calls = [];
  const entries = [];
  const counters = { config: 0, credential: 0 };
  const runtime = createAgentRuntime({ stateDir, scratchRoot,
    loadConfig: async () => { counters.config++; return structuredClone(config); },
    loadCredential: async () => { counters.credential++; return credential; },
    recordDiagnostic: async (_state, action, _model, result) => {
      entries.push({ action, result: structuredClone(result) });
    },
    request: async (_config, endpoint, receivedCredential, body, policy, control) => {
      assert.equal(endpoint, '/chat/completions');
      assert.equal(receivedCredential, credential);
      const index = calls.length;
      calls.push({ body: structuredClone(body), policy: structuredClone(policy), signal: control.signal });
      return await provider(index, body, policy);
    },
  });
  t.after(async () => {
    await runtime.dispose();
    const actual = realpathSync(root), scoped = relative(tempRoot, actual);
    assert.ok(actual === resolve(root) && scoped && !isAbsolute(scoped) && scoped !== '..'
      && !scoped.startsWith('..' + sep) && basename(actual).startsWith('codex-long-agent-test-'));
    rmSync(actual, { recursive: true, force: true });
  });
  return { runtime, root, stateDir, scratchRoot, calls, entries, counters };
}

function terminal(ctx) {
  const matches = ctx.entries.filter(entry => entry.action === 'agent_task');
  assert.equal(matches.length, 1, 'a terminal task is logged exactly once');
  return matches[0].result;
}
function onlyScratchFile(ctx, name) {
  const directories = readdirSync(ctx.scratchRoot);
  assert.equal(directories.length, 1);
  return join(ctx.scratchRoot, directories[0], name);
}

test('long defaults send the route output cap, fifteen-minute requests and thirty-minute step budget', async t => {
  clock(t);
  const ctx = fixture(t, () => done());
  const result = await ctx.runtime.start(input());
  assert.equal(result.state, 'completed');
  assert.equal(result.long_task_mode, true);
  assert.equal(result.unlimited_cumulative_budgets, true);
  assert.equal(result.request_timeout_ms, 900000);
  assert.equal(result.request_total_timeout_ms, 1800000);
  assert.equal(result.total_timeout_ms, 2 * hour);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].body.max_tokens, routeCap);
  assert.equal(ctx.calls[0].body.reasoning_effort, 'max');
  assert.equal(ctx.calls[0].body.model, configuration.models.flash);
  assert.match(ctx.calls[0].body.messages[0].content, new RegExp(String(routeCap)));
  assert.equal(ctx.calls[0].policy.timeoutMs, 900000);
  assert.equal(ctx.calls[0].policy.totalTimeoutMs, 1800000);
  assert.equal(ctx.calls[0].policy.maxAttempts, 3);
  const logged = terminal(ctx);
  assert.equal(logged.max_steps, 64);
  assert.equal(logged.max_tool_calls, 256);
  assert.equal(logged.max_http_attempts, 192);
  assert.equal(logged.total_timeout_ms, 2 * hour);
  assert.equal(logged.max_output_tokens, routeCap);
  assert.doesNotMatch(JSON.stringify([result, ctx.entries]), new RegExp(credential + '|' + reasoning));
});

test('long tasks cross forty-eight steps, ninety-six tools and 144 attempts without a token aggregate quota', async t => {
  clock(t);
  const ctx = fixture(t, index => {
    const response = index < 50 ? tools(call(`list_a_${index}`), call(`list_b_${index}`)) : done();
    response.metadata.attempts = 3;
    response.data.usage = { completion_tokens: routeCap,
      completion_tokens_details: { reasoning_tokens: routeCap - 1 } };
    return response;
  });
  const result = await ctx.runtime.start(input({ max_steps: 60, max_tool_calls: 128 }));
  assert.equal(result.state, 'completed');
  assert.equal(result.steps, 51);
  assert.equal(result.tool_calls, 100);
  assert.equal(result.http_attempts, 153);
  assert.equal(ctx.calls.length, 51);
  assert.ok(ctx.calls.every(item => item.policy.maxAttempts === 3 && item.body.max_tokens === routeCap));
  assert.equal(terminal(ctx).max_http_attempts, 180);
  assert.equal(ctx.counters.config, 1);
  assert.equal(ctx.counters.credential, 1);
});

test('third and later long resumptions extend the same multi-day task and never repeat a committed write', async t => {
  const time = clock(t);
  const content = 'SYNTHETIC-CHECKPOINT';
  const ctx = fixture(t, index => index === 0
    ? tools(call('checkpoint_once', 'write_file', { path: 'checkpoint.txt', content }))
    : index < 6 ? tools(call(`list_${index}`)) : done());
  let paused = await ctx.runtime.start(input({ max_steps: 1, max_tool_calls: 1 }));
  const file = onlyScratchFile(ctx, 'checkpoint.txt');
  utimesSync(file, new Date(1_000_000), new Date(1_000_000));
  const modified = statSync(file).mtimeMs;
  for (let phase = 1; phase <= 5; phase++) {
    time.now += hour;
    paused = await ctx.runtime.resume({ task_id: paused.task_id,
      additional_steps: 1, additional_tool_calls: 1, extend_timeout_ms: day });
    assert.equal(paused.state, 'paused');
    assert.equal(paused.pause_reason, 'step_limit');
    assert.equal(paused.recovery.resume_count, phase);
    assert.equal(paused.recovery.can_resume, true);
    assert.equal(paused.recovery.unlimited_cumulative_budgets, true);
    assert.equal(paused.recovery.additional_steps_available, null);
    assert.equal(paused.recovery.additional_tool_calls_available, null);
    assert.equal(paused.recovery.extend_timeout_ms_available, null);
    assert.equal(paused.recovery.total_timeout_ms, 2 * hour + phase * day);
    assert.equal(paused.recovery.remaining_timeout_ms, 2 * hour + phase * day - phase * hour);
    assert.deepEqual(paused.artifacts, [{ path: 'checkpoint.txt', content, sha256: hash(content) }]);
    assert.equal(statSync(file).mtimeMs, modified);
  }
  const completed = await ctx.runtime.resume({ task_id: paused.task_id, additional_steps: 1 });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.task_id, paused.task_id);
  assert.equal(completed.steps, 7);
  assert.equal(completed.tool_calls, 6);
  assert.equal(statSync(file).mtimeMs, modified);
  assert.equal(ctx.calls[6].body.messages.filter(item => item.tool_call_id === 'checkpoint_once').length, 1);
  assert.equal(terminal(ctx).total_timeout_ms, 2 * hour + 5 * day);
});

test('long resumptions accept the full explicit phase ranges and reject oversized additions without dispatch', async t => {
  clock(t);
  const ctx = fixture(t, index => index === 0 ? tools(call('list_once')) : done());
  const paused = await ctx.runtime.start(input({ max_steps: 1, max_tool_calls: 1 }));
  for (const extra of [{ additional_steps: 4097 },
    { additional_steps: 1, additional_tool_calls: 16385 },
    { additional_steps: 1, extend_timeout_ms: day + 1 }]) {
    await rejection(() => ctx.runtime.resume({ task_id: paused.task_id, ...extra }));
    const observed = await ctx.runtime.status({ task_id: paused.task_id });
    assert.equal(observed.state, 'paused');
    assert.equal(observed.recovery.resume_count, 0);
    assert.equal(ctx.calls.length, 1);
  }
  const completed = await ctx.runtime.resume({ task_id: paused.task_id,
    additional_steps: 4096, additional_tool_calls: 16384, extend_timeout_ms: day });
  assert.equal(completed.state, 'completed');
  const logged = terminal(ctx);
  assert.equal(logged.max_steps, 4097);
  assert.equal(logged.max_tool_calls, 16385);
  assert.equal(logged.max_http_attempts, 4097 * 3);
  assert.equal(logged.total_timeout_ms, 2 * hour + day);
  assert.equal(ctx.calls.length, 2);
});

test('caller budgets override long defaults and the active deadline bounds request timeouts', async t => {
  clock(t);
  const ctx = fixture(t, () => done());
  const result = await ctx.runtime.start(input({ max_output_tokens: 16384,
    max_steps: 2, max_tool_calls: 7, total_timeout_ms: 75000 }));
  assert.equal(result.state, 'completed');
  assert.equal(ctx.calls[0].body.max_tokens, 16384);
  assert.equal(ctx.calls[0].policy.timeoutMs, 75000);
  assert.equal(ctx.calls[0].policy.totalTimeoutMs, 75000);
  const logged = terminal(ctx);
  assert.equal(logged.max_steps, 2);
  assert.equal(logged.max_tool_calls, 7);
  assert.equal(logged.total_timeout_ms, 75000);
  assert.equal(logged.max_http_attempts, 6);
});

test('long configured defaults are used only when callers omit the corresponding budgets', async t => {
  clock(t);
  const ctx = fixture(t, () => done(), { ...configuration, long_task_policy: {
    enabled: true, initial_steps: 80, initial_tool_calls: 300, task_timeout_ms: 3 * hour,
    request_timeout_ms: 1_200_000, request_total_timeout_ms: 2_400_000,
  } });
  const result = await ctx.runtime.start(input());
  assert.equal(result.state, 'completed');
  assert.equal(ctx.calls[0].body.max_tokens, routeCap);
  assert.equal(ctx.calls[0].policy.timeoutMs, 1_200_000);
  assert.equal(ctx.calls[0].policy.totalTimeoutMs, 2_400_000);
  const logged = terminal(ctx);
  assert.equal(logged.max_steps, 80);
  assert.equal(logged.max_tool_calls, 300);
  assert.equal(logged.total_timeout_ms, 3 * hour);
});

test('route caps and max minimum output guards still refuse before credentials and HTTP', async t => {
  clock(t);
  const ctx = fixture(t, () => { assert.fail('A rejected budget must not dispatch a request.'); });
  await rejection(() => ctx.runtime.start(input({ max_output_tokens: routeCap + 1 })));
  assert.equal(ctx.counters.credential, 0);
  assert.equal(ctx.calls.length, 0);
  assert.deepEqual(readdirSync(ctx.scratchRoot), []);
  const failed = await ctx.runtime.start(input({ max_output_tokens: 4096 }));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error_code, 'output_budget_insufficient');
  assert.equal(failed.output_budget.requested_output_tokens, 4096);
  assert.equal(failed.output_budget.minimum_output_tokens, 16384);
  assert.equal(failed.steps, 0);
  assert.equal(failed.http_attempts, 0);
  assert.equal(ctx.counters.credential, 0);
  assert.equal(ctx.calls.length, 0);
  assert.deepEqual(readdirSync(ctx.scratchRoot), []);
  assert.equal(terminal(ctx).state, 'failed');
});

test('injected configuration still validates the long policy before credentials and HTTP', async t => {
  clock(t);
  const ctx = fixture(t, () => { assert.fail('Invalid configuration must not dispatch.'); }, {
    ...configuration, long_task_policy: { enabled: true, unknown_setting: true },
  });
  const failed = await ctx.runtime.start(input());
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error_code, 'configuration_invalid');
  assert.equal(ctx.counters.credential, 0);
  assert.equal(ctx.calls.length, 0);
  assert.deepEqual(readdirSync(ctx.scratchRoot), []);
  assert.equal(terminal(ctx).http_attempts, 0);
});

test('long broker waits accept only fresh one-time results and preserve previously written files', async t => {
  clock(t);
  const ctx = fixture(t, index => index === 0 ? tools(
    call('write_once', 'write_file', { path: 'draft.txt', content: 'SYNTHETIC-DRAFT' }),
    call('broker_once', 'codex_tool', { name: plugin.name, arguments: {} })) : done());
  const waiting = await ctx.runtime.start(input({ max_steps: 1, max_tool_calls: 2, plugin_tools: [plugin] }));
  assert.equal(waiting.state, 'waiting_for_tools');
  assert.equal(waiting.requests.length, 1);
  const file = onlyScratchFile(ctx, 'draft.txt');
  utimesSync(file, new Date(1_000_000), new Date(1_000_000));
  const results = [{ request_id: 'broker_once', result: { value: 'SYNTHETIC-HOST' } }];
  await rejection(() => ctx.runtime.resume({ task_id: waiting.task_id, results, additional_steps: 1 }));
  await rejection(() => ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: 'unknown', result: 'stale' }] }));
  await rejection(() => ctx.runtime.resume({ task_id: waiting.task_id, results: [results[0], results[0]] }));
  assert.equal(ctx.calls.length, 1);
  const paused = await ctx.runtime.resume({ task_id: waiting.task_id, results });
  assert.equal(paused.state, 'paused');
  assert.equal(paused.pause_reason, 'step_limit');
  await rejection(() => ctx.runtime.resume({ task_id: waiting.task_id, results, additional_steps: 1 }));
  const completed = await ctx.runtime.resume({ task_id: waiting.task_id, additional_steps: 1 });
  assert.equal(completed.state, 'completed');
  assert.equal(statSync(file).mtimeMs, 1_000_000);
  assert.deepEqual(ctx.calls[1].body.messages.filter(item => item.role === 'tool').map(item => item.tool_call_id),
    ['write_once', 'broker_once']);
  await rejection(() => ctx.runtime.resume({ task_id: waiting.task_id, results }), 'invalid_state');
  assert.equal(ctx.calls.length, 2);
});

test('concurrent long recovery dispatches once and cancellation remains terminal', async t => {
  clock(t);
  let entered, release;
  const begun = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const ctx = fixture(t, index => index === 0 ? tools(call('list_once')) : (entered(), pending));
  const paused = await ctx.runtime.start(input({ max_steps: 1 }));
  const args = { task_id: paused.task_id, additional_steps: 1 };
  const running = ctx.runtime.resume(args);
  await begun;
  await rejection(() => ctx.runtime.resume(args), 'invalid_state');
  const cancelling = await ctx.runtime.cancel({ task_id: paused.task_id });
  assert.equal(cancelling.state, 'cancelling');
  assert.equal(ctx.calls[1].signal.aborted, true);
  release(done());
  assert.equal((await running).state, 'cancelled');
  await rejection(() => ctx.runtime.resume(args), 'invalid_state');
  assert.equal((await ctx.runtime.cancel({ task_id: paused.task_id })).state, 'cancelled');
  assert.equal(ctx.calls.length, 2);
  assert.equal(terminal(ctx).state, 'cancelled');
});

test('a cancelled long broker checkpoint cannot dispatch another request', async t => {
  clock(t);
  const ctx = fixture(t, () => tools(call('broker_once', 'codex_tool', { name: plugin.name, arguments: {} })));
  const waiting = await ctx.runtime.start(input({ plugin_tools: [plugin] }));
  assert.equal(waiting.state, 'waiting_for_tools');
  assert.equal((await ctx.runtime.cancel({ task_id: waiting.task_id })).state, 'cancelled');
  await rejection(() => ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: 'broker_once', result: 'HOST' }] }), 'invalid_state');
  assert.equal(ctx.calls.length, 1);
  assert.equal(terminal(ctx).state, 'cancelled');
});

test('long extensions add to the original deadline and expired tasks cannot be revived', async t => {
  const time = clock(t);
  const ctx = fixture(t, index => tools(call(`list_${index}`)));
  const paused = await ctx.runtime.start(input({ max_steps: 1, total_timeout_ms: 1000 }));
  time.now += 600;
  const continued = await ctx.runtime.resume({ task_id: paused.task_id,
    additional_steps: 1, extend_timeout_ms: day });
  assert.equal(continued.state, 'paused');
  assert.equal(continued.recovery.total_timeout_ms, day + 1000);
  assert.equal(continued.recovery.remaining_timeout_ms, day + 400);
  assert.equal(continued.elapsed_ms, 600);
  time.now += day + 401;
  const failed = await ctx.runtime.resume({ task_id: paused.task_id,
    additional_steps: 1, extend_timeout_ms: day });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error_code, 'deadline_exceeded');
  assert.equal(failed.elapsed_ms, day + 1001);
  await rejection(() => ctx.runtime.resume({ task_id: paused.task_id, additional_steps: 1 }), 'invalid_state');
  assert.equal(ctx.calls.length, 2);
  assert.equal(terminal(ctx).elapsed_ms, day + 1001);
});

test('long calls yield time slices and require sufficient deadline extension before another full step', async t => {
  const time = clock(t);
  const ctx = fixture(t, index => {
    if (index === 5) return done();
    time.now += 20 * 60_000;
    return tools(call(`list_${index}`));
  });
  const first = await ctx.runtime.start(input());
  assert.equal(first.state, 'paused');
  assert.equal(first.pause_reason, 'time_slice');
  assert.equal(first.steps, 2);
  assert.equal(first.execution_slice_ms, hour);
  assert.equal(first.recovery.needs_deadline_extension, false);
  assert.equal(first.recovery.minimum_deadline_extension_ms, 0);
  assert.equal(first.recovery.can_resume, true);
  const second = await ctx.runtime.resume({ task_id: first.task_id });
  assert.equal(second.pause_reason, 'time_slice');
  assert.equal(second.steps, 4);
  assert.equal(second.recovery.resume_count, 1);
  const third = await ctx.runtime.resume({ task_id: first.task_id });
  assert.equal(third.pause_reason, 'time_slice');
  assert.equal(third.steps, 5);
  assert.equal(third.recovery.resume_count, 2);
  assert.equal(third.recovery.needs_deadline_extension, true);
  assert.equal(third.recovery.minimum_deadline_extension_ms, 600000);
  assert.equal(third.recovery.can_resume, true);
  for (const extra of [{}, { extend_timeout_ms: 599999 }]) {
    await rejection(() => ctx.runtime.resume({ task_id: first.task_id, ...extra }));
    assert.equal(ctx.calls.length, 5, 'insufficient extension must not dispatch or consume a continuation');
  }
  const completed = await ctx.runtime.resume({ task_id: first.task_id, extend_timeout_ms: 600000 });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.steps, 6);
  assert.equal(completed.total_timeout_ms, 2 * hour + 600000);
  assert.equal(ctx.calls.length, 6);
  assert.equal(terminal(ctx).elapsed_ms, 100 * 60_000);
});

test('long cumulative extension still rejects unsafe deadline arithmetic without consuming its checkpoint', async t => {
  const time = clock(t);
  time.now = Number.MAX_SAFE_INTEGER - 2;
  const ctx = fixture(t, index => tools(call(`list_${index}`)));
  const paused = await ctx.runtime.start(input({ max_steps: 1, total_timeout_ms: 1 }));
  assert.equal(paused.state, 'paused');
  await rejection(() => ctx.runtime.resume({ task_id: paused.task_id,
    additional_steps: 1, extend_timeout_ms: 2 }));
  const observed = await ctx.runtime.status({ task_id: paused.task_id });
  assert.equal(observed.state, 'paused');
  assert.equal(observed.recovery.resume_count, 0);
  assert.equal(observed.recovery.total_timeout_ms, 1);
  assert.equal(ctx.calls.length, 1);
});

test('long mode retains the configured history byte boundary independently of cumulative quotas', async t => {
  clock(t);
  const ctx = fixture(t, index => tools(call(`read_${index}`, 'read_file', { path: 'large.txt' })), {
    ...configuration, capabilities: { flash: { max_output_tokens: routeCap } },
  });
  const failed = await ctx.runtime.start(input({ task: 'T'.repeat(110 * 1024),
    files: [{ path: 'large.txt', content: 'X'.repeat(60 * 1024) }] }));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error_code, 'context_too_large');
  assert.equal(failed.unlimited_cumulative_budgets, true);
  assert.ok(ctx.calls.length >= 2 && ctx.calls.length <= 3);
  assert.ok(ctx.calls.every(item => Buffer.byteLength(JSON.stringify(item.body.messages)) <= 256 * 1024));
  assert.equal(terminal(ctx).error_code, 'context_too_large');
});

for (const expected of ['answer_truncated', 'model_response_invalid', 'api_http_error']) {
  test(`long mode keeps ${expected} terminal without replay, output expansion or model fallback`, async t => {
    clock(t);
    const ctx = fixture(t, () => {
      if (expected === 'api_http_error') throw Object.assign(new Error('Synthetic authentication failure.'), {
        code: expected, status: 401, metadata: { attempts: 1, http_status: 401, error_category: 'http_status' },
      });
      if (expected === 'model_response_invalid') return { data: { choices: [] }, metadata: { attempts: 1 } };
      const response = tools(call('unfinished_write', 'write_file', { path: 'missing.txt', content: 'INCOMPLETE' }));
      response.data.choices[0].finish_reason = 'length';
      response.data.usage = { completion_tokens: routeCap,
        completion_tokens_details: { reasoning_tokens: routeCap } };
      return response;
    });
    const failed = await ctx.runtime.start(input());
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error_code, expected);
    assert.equal(failed.max_output_tokens, routeCap);
    assert.equal(failed.steps, 1);
    assert.equal(failed.http_attempts, 1);
    assert.equal(failed.tool_calls, 0);
    assert.deepEqual(failed.artifacts, []);
    await rejection(() => ctx.runtime.resume({ task_id: failed.task_id, additional_steps: 1 }), 'invalid_state');
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.calls[0].body.model, configuration.models.flash);
    assert.equal(terminal(ctx).error_code, expected);
  });
}

test('legacy configuration retains its original defaults and phase bounds', async t => {
  clock(t);
  const legacy = { ...configuration, default_reasoning_effort: 'none' };
  delete legacy.long_task_policy;
  delete legacy.output_budget_policy;
  const ctx = fixture(t, () => done(), legacy);
  const result = await ctx.runtime.start(input());
  assert.equal(result.state, 'completed');
  assert.equal(result.long_task_mode, undefined);
  assert.equal(ctx.calls[0].body.max_tokens, 4096);
  assert.equal(ctx.calls[0].policy.timeoutMs, 180000);
  assert.equal(ctx.calls[0].policy.totalTimeoutMs, 360000);
  const logged = terminal(ctx);
  assert.equal(logged.max_steps, 12);
  assert.equal(logged.max_tool_calls, 24);
  assert.equal(logged.max_http_attempts, 36);
  assert.equal(logged.total_timeout_ms, 360000);
  for (const extra of [{ max_steps: 13 }, { max_tool_calls: 33 }, { total_timeout_ms: 900001 }]) {
    await rejection(() => ctx.runtime.start(input(extra)));
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.counters.credential, 1);
  }
});
