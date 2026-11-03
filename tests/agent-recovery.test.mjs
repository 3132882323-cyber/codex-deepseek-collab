// Recovery contracts use synthetic provider replies and a test-owned scratch tree.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync,
  rmSync, statSync, utimesSync } from 'node:fs';
import { createAgentRuntime } from '../skills/deepseek-collaboration/scripts/deepseek-agent-runtime.mjs';

const tempRoot = realpathSync(tmpdir());
const credential = 'SYNTHETIC-RECOVERY-CREDENTIAL';
const reasoning = 'SYNTHETIC-PRIVATE-REASONING';
const config = { base_url: 'https://api.example.test/v1', allowed_origin: 'https://api.example.test',
  protocol: 'openai', model: 'deepseek-flash-test', models: { flash: 'deepseek-flash-test' },
  credential_source: 'env' };
const plugin = { name: 'synthetic_lookup', description: 'Synthetic lookup.', input_schema: { type: 'object' } };
globalThis.fetch = async () => { throw new Error('Recovery tests forbid network access.'); };

function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
function tools(...calls) {
  return { data: { choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null, tool_calls: calls, reasoning_content: reasoning,
  } }] }, metadata: { attempts: 1 } };
}
function done() {
  return { data: { choices: [{ finish_reason: 'stop', message: {
    role: 'assistant', content: 'Synthetic recovery complete.', reasoning_content: reasoning,
  } }] }, metadata: { attempts: 1 } };
}
const input = extra => ({ task: 'Complete the synthetic file task.', model: 'flash', ...extra });
const digest = content => createHash('sha256').update(content).digest('hex');
const rejection = (operation, code) => assert.rejects(operation, error => error?.code === code);

function fixture(t, provider, configuration = config) {
  const root = mkdtempSync(join(tempRoot, 'codex-agent-recovery-test-'));
  const stateDir = join(root, 'state');
  const scratchRoot = join(root, 'scratch');
  mkdirSync(stateDir); mkdirSync(scratchRoot);
  const calls = [];
  const entries = [];
  const counters = { config: 0, credential: 0 };
  const runtime = createAgentRuntime({ stateDir, scratchRoot,
    loadConfig: async () => { counters.config++; return structuredClone(configuration); },
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
  const files = () => readdirSync(scratchRoot).flatMap(directory => readdirSync(join(scratchRoot, directory))
    .map(name => join(scratchRoot, directory, name)));
  t.after(async () => {
    await runtime.dispose();
    const actual = realpathSync(root), scoped = relative(tempRoot, actual);
    assert.ok(actual === resolve(root) && scoped && !isAbsolute(scoped) && scoped !== '..'
      && !scoped.startsWith('..' + sep) && basename(actual).startsWith('codex-agent-recovery-test-'));
    rmSync(actual, { recursive: true, force: true });
  });
  return { runtime, root, scratchRoot, files, calls, entries, counters };
}

test('six steps pause with hashes, then the same task completes at step seven without repeating its write', async t => {
  const ctx = fixture(t, index => index === 0
    ? tools(call('write_checkpoint', 'write_file', { path: 'checkpoint.txt', content: 'CHECKPOINT' }))
    : index < 6 ? tools(call(`list_${index}`, 'list_files', {})) : done());
  const paused = await ctx.runtime.start(input({ max_steps: 6, reasoning_effort: 'max' }));
  assert.equal(paused.state, 'paused');
  assert.equal(paused.pause_reason, 'step_limit');
  assert.equal(paused.steps, 6); assert.equal(paused.tool_calls, 6); assert.equal(paused.http_attempts, 6);
  assert.deepEqual(paused.artifacts, [{ path: 'checkpoint.txt', content: 'CHECKPOINT', sha256: digest('CHECKPOINT') }]);
  assert.equal(ctx.entries.filter(entry => entry.action === 'agent_task').length, 0);
  const file = ctx.files()[0];
  utimesSync(file, new Date(1_000_000), new Date(1_000_000));
  const checkpointTime = statSync(file).mtimeMs;
  const observed = await ctx.runtime.status({ task_id: paused.task_id });
  assert.equal(observed.state, 'paused');
  assert.deepEqual(observed.artifacts, paused.artifacts);
  assert.equal(observed.recovery.max_steps, 6);
  const completed = await ctx.runtime.resume({ task_id: paused.task_id, additional_steps: 1 });
  assert.equal(completed.state, 'completed'); assert.equal(completed.task_id, paused.task_id);
  assert.equal(completed.steps, 7); assert.equal(completed.tool_calls, 6); assert.equal(completed.http_attempts, 7);
  assert.equal(statSync(file).mtimeMs, checkpointTime, 'an already committed write must not run again');
  assert.equal(ctx.counters.config, 1); assert.equal(ctx.counters.credential, 1);
  const messages = ctx.calls[6].body.messages;
  assert.equal(messages.filter(message => message.role === 'tool' && message.tool_call_id === 'write_checkpoint').length, 1);
  assert.equal(messages.filter(message => message.role === 'assistant' && message.reasoning_content === reasoning).length, 6);
  const terminal = ctx.entries.filter(entry => entry.action === 'agent_task');
  assert.equal(terminal.length, 1); assert.equal(terminal[0].result.max_steps, 7);
  assert.equal(terminal[0].result.steps, 7);
  assert.doesNotMatch(JSON.stringify([paused, completed, ctx.entries]), /SYNTHETIC-PRIVATE-REASONING|SYNTHETIC-RECOVERY-CREDENTIAL/);
});

test('ordinary starts now have twelve steps and twenty-four tool calls', async t => {
  const ctx = fixture(t, () => done());
  await ctx.runtime.start(input());
  const terminal = ctx.entries.find(entry => entry.action === 'agent_task').result;
  assert.equal(terminal.max_steps, 12); assert.equal(terminal.max_tool_calls, 24);
  assert.equal(terminal.max_http_attempts, 36);
});

test('tool_limit saves the whole valid batch and resumes it exactly once before the next POST', async t => {
  const ctx = fixture(t, index => index === 0 ? tools(
    call('write_one', 'write_file', { path: 'one.txt', content: 'ONE' }),
    call('write_two', 'write_file', { path: 'two.txt', content: 'TWO' })) : done());
  const paused = await ctx.runtime.start(input({ max_tool_calls: 1 }));
  assert.equal(paused.state, 'paused'); assert.equal(paused.pause_reason, 'tool_limit');
  assert.equal(paused.steps, 1); assert.equal(paused.tool_calls, 0);
  assert.equal(paused.recovery.pending_tool_calls, 2);
  assert.deepEqual(ctx.files(), []); assert.equal(ctx.calls.length, 1);
  await rejection(() => ctx.runtime.resume({ task_id: paused.task_id }), 'invalid_argument');
  const completed = await ctx.runtime.resume({ task_id: paused.task_id, additional_tool_calls: 1 });
  assert.equal(completed.state, 'completed'); assert.equal(completed.task_id, paused.task_id);
  assert.equal(completed.steps, 2); assert.equal(completed.tool_calls, 2); assert.equal(ctx.calls.length, 2);
  assert.deepEqual(completed.artifacts.map(file => file.content).sort(), ['ONE', 'TWO']);
  const messages = ctx.calls[1].body.messages;
  assert.equal(messages.filter(item => item.role === 'assistant' && item.tool_calls?.length === 2).length, 1);
  assert.deepEqual(messages.filter(item => item.role === 'tool').map(item => item.tool_call_id), ['write_one', 'write_two']);
  await rejection(() => ctx.runtime.resume({ task_id: paused.task_id, additional_tool_calls: 1 }), 'invalid_state');
  assert.equal(ctx.files().length, 2);
});

test('a thirty-two-tool batch accepts two bounded budget additions without executing during the first', async t => {
  const batch = Array.from({ length: 32 }, (_, index) => call(`write_${index}`, 'write_file', {
    path: `part-${index}.txt`, content: `PART-${index}`,
  }));
  const ctx = fixture(t, index => index === 0 ? tools(...batch) : done());
  const paused = await ctx.runtime.start(input({ max_tool_calls: 1, max_steps: 2 }));
  assert.equal(paused.pause_reason, 'tool_limit');
  const funded = await ctx.runtime.resume({ task_id: paused.task_id, additional_tool_calls: 24 });
  assert.equal(funded.state, 'paused'); assert.equal(funded.task_id, paused.task_id);
  assert.equal(funded.recovery.max_tool_calls, 25); assert.equal(funded.recovery.pending_tool_calls, 32);
  assert.equal(funded.recovery.budget_added, true);
  assert.deepEqual(funded.recovery.last_budget_addition, {
    additional_steps: 0, additional_tool_calls: 24, extend_timeout_ms: 0,
  });
  assert.equal(ctx.calls.length, 1); assert.equal(funded.tool_calls, 0); assert.deepEqual(ctx.files(), []);
  const completed = await ctx.runtime.resume({ task_id: paused.task_id, additional_tool_calls: 7 });
  assert.equal(completed.state, 'completed'); assert.equal(completed.tool_calls, 32);
  assert.equal(completed.artifacts.length, 32); assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[1].body.messages.filter(item => item.role === 'tool').length, 32);
});

test('a mixed batch preserves its local result while waiting for exactly-once plugin results', async t => {
  const ctx = fixture(t, index => index === 0 ? tools(
    call('write_local', 'write_file', { path: 'local.txt', content: 'LOCAL' }),
    call('broker_once', 'codex_tool', { name: plugin.name, arguments: { key: 'synthetic' } })) : done());
  const paused = await ctx.runtime.start(input({ plugin_tools: [plugin], max_tool_calls: 1 }));
  const waiting = await ctx.runtime.resume({ task_id: paused.task_id, additional_tool_calls: 1 });
  assert.equal(waiting.state, 'waiting_for_tools'); assert.equal(waiting.task_id, paused.task_id);
  assert.equal(waiting.tool_calls, 2); assert.equal(ctx.calls.length, 1);
  assert.deepEqual(waiting.requests, [{ request_id: 'broker_once', tool_name: plugin.name, arguments: { key: 'synthetic' } }]);
  const file = ctx.files()[0]; utimesSync(file, new Date(1_000_000), new Date(1_000_000));
  const result = { task_id: paused.task_id, results: [{ request_id: 'broker_once', result: { value: 'HOST' } }] };
  await rejection(() => ctx.runtime.resume({ ...result, additional_steps: 1 }), 'invalid_argument');
  assert.equal((await ctx.runtime.status({ task_id: paused.task_id })).state, 'waiting_for_tools');
  const completed = await ctx.runtime.resume(result);
  assert.equal(completed.state, 'completed'); assert.equal(ctx.calls.length, 2);
  assert.equal(statSync(file).mtimeMs, 1_000_000);
  assert.deepEqual(ctx.calls[1].body.messages.filter(item => item.role === 'tool').map(item => item.tool_call_id),
    ['write_local', 'broker_once']);
  await rejection(() => ctx.runtime.resume(result), 'invalid_state');
});

test('plugin continuation reaches a step pause without consuming its results twice', async t => {
  const ctx = fixture(t, index => index === 0 ? tools(call('broker_once', 'codex_tool', {
    name: plugin.name, arguments: {},
  })) : done());
  const waiting = await ctx.runtime.start(input({ plugin_tools: [plugin], max_steps: 1 }));
  const results = [{ request_id: 'broker_once', result: 'HOST' }];
  const paused = await ctx.runtime.resume({ task_id: waiting.task_id, results });
  assert.equal(paused.state, 'paused'); assert.equal(paused.pause_reason, 'step_limit');
  assert.equal(paused.steps, 1); assert.equal(ctx.calls.length, 1);
  await rejection(() => ctx.runtime.resume({ task_id: paused.task_id, results, additional_steps: 1 }), 'invalid_argument');
  const completed = await ctx.runtime.resume({ task_id: paused.task_id, additional_steps: 1 });
  assert.equal(completed.state, 'completed'); assert.equal(completed.steps, 2);
  assert.equal(ctx.calls[1].body.messages.filter(item => item.tool_call_id === 'broker_once').length, 1);
});

test('missing, invalid and excessive recovery budgets preserve the paused checkpoint', async t => {
  const ctx = fixture(t, index => tools(call(`list_${index}`, 'list_files', {})));
  const paused = await ctx.runtime.start(input({ max_steps: 1 }));
  for (const extra of [{}, { additional_tool_calls: 1 }, { extend_timeout_ms: 1 },
    { additional_steps: 0 }, { additional_steps: 13 }, { additional_steps: 1.5 },
    { additional_steps: 1, additional_tool_calls: 25 }, { additional_steps: 1, extend_timeout_ms: 360001 }]) {
    await rejection(() => ctx.runtime.resume({ task_id: paused.task_id, ...extra }), 'invalid_argument');
    const observed = await ctx.runtime.status({ task_id: paused.task_id });
    assert.equal(observed.state, 'paused'); assert.equal(observed.steps, 1);
    assert.equal(observed.recovery.max_steps, 1); assert.equal(observed.recovery.resume_count, 0);
    assert.equal(ctx.calls.length, 1);
  }
});

test('cumulative step, tool and HTTP caps stay bounded and a refused addition does not discard pause state', async t => {
  const ctx = fixture(t, index => tools(call(`list_${index}`, 'list_files', {})));
  let paused = await ctx.runtime.start(input({ max_steps: 1, max_tool_calls: 24 }));
  for (let index = 0; index < 3; index++) {
    paused = await ctx.runtime.resume({ task_id: paused.task_id, additional_steps: 12, additional_tool_calls: 24 });
    assert.equal(paused.state, 'paused'); assert.equal(paused.pause_reason, 'step_limit');
  }
  paused = await ctx.runtime.resume({ task_id: paused.task_id, additional_steps: 11 });
  assert.equal(paused.steps, 48); assert.equal(paused.recovery.max_steps, 48);
  assert.equal(paused.recovery.max_tool_calls, 96); assert.equal(paused.recovery.max_http_attempts, 144);
  assert.equal(paused.recovery.can_resume, false);
  for (const extra of [{ additional_steps: 1 }, { additional_steps: 1, additional_tool_calls: 1 }]) {
    await rejection(() => ctx.runtime.resume({ task_id: paused.task_id, ...extra }), 'invalid_argument');
    const observed = await ctx.runtime.status({ task_id: paused.task_id });
    assert.equal(observed.state, 'paused'); assert.equal(observed.steps, 48);
    assert.equal(observed.recovery.max_steps, 48); assert.equal(observed.recovery.max_tool_calls, 96);
  }
  assert.equal(ctx.calls.length, 48);
  assert.ok(ctx.calls.every(entry => entry.policy.maxAttempts <= 3));
});

test('deadline extension is added to the same task deadline and expired checkpoints cannot revive', async t => {
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    const ctx = fixture(t, index => tools(call(`list_${index}`, 'list_files', {})));
    const paused = await ctx.runtime.start(input({ max_steps: 1, total_timeout_ms: 1000 }));
    now += 600;
    const continued = await ctx.runtime.resume({ task_id: paused.task_id, additional_steps: 1, extend_timeout_ms: 500 });
    assert.equal(continued.state, 'paused'); assert.equal(continued.task_id, paused.task_id);
    assert.equal(continued.steps, 2); assert.equal(continued.recovery.total_timeout_ms, 1500);
    assert.equal(continued.recovery.remaining_timeout_ms, 900);
    assert.equal(ctx.calls[1].policy.totalTimeoutMs, 900);
    now += 901;
    const failed = await ctx.runtime.resume({ task_id: paused.task_id, additional_steps: 1, extend_timeout_ms: 1000 });
    assert.equal(failed.state, 'failed'); assert.equal(failed.error_code, 'deadline_exceeded');
    assert.equal(ctx.calls.length, 2);
    await rejection(() => ctx.runtime.resume({ task_id: paused.task_id, additional_steps: 1 }), 'invalid_state');
    assert.equal(ctx.entries.filter(entry => entry.action === 'agent_task').length, 1);
  } finally { Date.now = realNow; }
});

test('the ninety-six-tool hard cap refuses another batch without losing its pending call', async t => {
  const ctx = fixture(t, index => tools(...Array.from({ length: index < 3 ? 32 : 1 }, (_, item) =>
    call(`list_${index}_${item}`, 'list_files', {}))));
  let paused = await ctx.runtime.start(input({ max_tool_calls: 1 }));
  for (const additional_tool_calls of [24, 7, 24, 8, 24, 8]) {
    paused = await ctx.runtime.resume({ task_id: paused.task_id, additional_tool_calls });
    assert.equal(paused.state, 'paused'); assert.equal(paused.pause_reason, 'tool_limit');
  }
  assert.equal(paused.tool_calls, 96); assert.equal(paused.recovery.max_tool_calls, 96);
  assert.equal(paused.recovery.pending_tool_calls, 1); assert.equal(paused.recovery.can_resume, false);
  await rejection(() => ctx.runtime.resume({ task_id: paused.task_id, additional_tool_calls: 1 }), 'invalid_argument');
  const observed = await ctx.runtime.status({ task_id: paused.task_id });
  assert.equal(observed.state, 'paused'); assert.equal(observed.recovery.pending_tool_calls, 1);
  assert.equal(observed.tool_calls, 96); assert.equal(ctx.calls.length, 4);
});

test('the cumulative thirty-minute deadline cap is enforced before consuming a checkpoint', async t => {
  const ctx = fixture(t, index => tools(call(`list_${index}`, 'list_files', {})));
  let paused = await ctx.runtime.start(input({ max_steps: 1, total_timeout_ms: 900000 }));
  for (const timeout of [360000, 360000, 180000]) {
    paused = await ctx.runtime.resume({ task_id: paused.task_id, additional_steps: 1, extend_timeout_ms: timeout });
    assert.equal(paused.state, 'paused');
  }
  assert.equal(paused.recovery.total_timeout_ms, 1800000);
  await rejection(() => ctx.runtime.resume({ task_id: paused.task_id, additional_steps: 1, extend_timeout_ms: 1 }), 'invalid_argument');
  const observed = await ctx.runtime.status({ task_id: paused.task_id });
  assert.equal(observed.state, 'paused'); assert.equal(observed.recovery.total_timeout_ms, 1800000);
  assert.equal(ctx.calls.length, 4);
  assert.ok(ctx.calls.every(entry => entry.policy.timeoutMs <= 180000 && entry.policy.totalTimeoutMs <= 360000));
});

test('simultaneous recovery accepts one continuation and cancellation remains terminal', async t => {
  let release; let entered;
  const begun = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const ctx = fixture(t, index => index === 0 ? tools(call('list_once', 'list_files', {})) : (entered(), pending));
  const paused = await ctx.runtime.start(input({ max_steps: 1 }));
  const args = { task_id: paused.task_id, additional_steps: 1 };
  const running = ctx.runtime.resume(args);
  await begun;
  await rejection(() => ctx.runtime.resume(args), 'invalid_state');
  const cancelled = await ctx.runtime.cancel({ task_id: paused.task_id });
  assert.equal(cancelled.state, 'cancelling');
  release(done());
  assert.equal((await running).state, 'cancelled');
  await rejection(() => ctx.runtime.resume(args), 'invalid_state');
  assert.equal(ctx.calls.length, 2); assert.equal(ctx.entries.filter(entry => entry.action === 'agent_task').length, 1);
});

test('cancelling a paused task clears its recovery opportunity without another request', async t => {
  const ctx = fixture(t, () => tools(call('list_once', 'list_files', {})));
  const paused = await ctx.runtime.start(input({ max_steps: 1 }));
  assert.equal((await ctx.runtime.cancel({ task_id: paused.task_id })).state, 'cancelled');
  await rejection(() => ctx.runtime.resume({ task_id: paused.task_id, additional_steps: 1 }), 'invalid_state');
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.entries.filter(entry => entry.action === 'agent_task').length, 1);
});

test('truncated, invalid and authentication failures stay terminal and cannot replay a model request', async t => {
  for (const errorCode of ['answer_truncated', 'tool_call_invalid', 'api_http_error', 'invalid_argument', 'request_failed']) {
    const ctx = fixture(t, () => {
      if (errorCode === 'answer_truncated') {
        const reply = done(); reply.data.choices[0].finish_reason = 'length'; return reply;
      }
      if (errorCode === 'tool_call_invalid') return tools(call('invalid_tool', 'unregistered', {}));
      throw Object.assign(new Error('SYNTHETIC-RAW-ERROR'), { code: errorCode });
    });
    const failed = await ctx.runtime.start(input({ max_tool_calls: 1 }));
    assert.equal(failed.state, 'failed'); assert.equal(failed.error_code, errorCode);
    await rejection(() => ctx.runtime.resume({ task_id: failed.task_id, additional_steps: 1 }), 'invalid_state');
    assert.equal(ctx.calls.length, 1); assert.equal(ctx.entries.filter(entry => entry.action === 'agent_task').length, 1);
  }
});

test('output-budget preflight still rejects before reading a credential or making a request', async t => {
  const ctx = fixture(t, () => done(), { ...config, default_reasoning_effort: 'max',
    capabilities: { flash: { max_output_tokens: 32768 } },
    output_budget_policy: { flash: { max_reasoning_min_output_tokens: 16384 } } });
  const failed = await ctx.runtime.start(input());
  assert.equal(failed.state, 'failed'); assert.equal(failed.error_code, 'output_budget_insufficient');
  assert.equal(ctx.counters.credential, 0); assert.equal(ctx.calls.length, 0);
  await rejection(() => ctx.runtime.resume({ task_id: failed.task_id, additional_steps: 1 }), 'invalid_state');
});
