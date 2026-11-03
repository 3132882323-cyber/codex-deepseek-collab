// Offline observable-contract tests for the bounded agent. Every credential,
// provider response, file, and broker result below is synthetic.
import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createAgentRuntime } from '../skills/deepseek-collaboration/scripts/deepseek-agent-runtime.mjs';
import { recordDiagnostic } from '../skills/deepseek-collaboration/scripts/deepseek-client.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 10_000 }, fn);
const tempRoot = realpathSync(tmpdir());
const syntheticCredential = 'sk-SYNTHETIC-AGENT-OFFLINE-DO-NOT-USE';
const unsafeReasoning = 'SYNTHETIC-HIDDEN-REASONING-DO-NOT-EMIT';
const models = { flash: 'deepseek-flash-test-fixture', pro: 'deepseek-pro-test-fixture' };
const configuration = {
  base_url: 'https://api.example.test/v1', allowed_origin: 'https://api.example.test',
  protocol: 'openai', model: models.flash, models, credential_source: 'env',
};
function outputBudgetConfiguration(withPolicy = true) {
  return { ...configuration, default_reasoning_effort: 'max',
    capabilities: { flash: { max_output_tokens: 32768 } },
    ...(withPolicy ? { output_budget_policy: { flash: { max_reasoning_min_output_tokens: 16384 } } } : {}) };
}
const plugin = { name: 'lookup_reference', description: 'Get a synthetic display prefix.',
  input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } };

// A regression that bypasses request injection must still never use networking.
globalThis.fetch = async () => { throw new Error('Offline agent tests forbid network access.'); };

function completion(content = 'Synthetic task complete.') {
  return { data: { model: models.flash, choices: [{ finish_reason: 'stop', message: {
    role: 'assistant', content, reasoning_content: unsafeReasoning,
  } }] }, metadata: { attempts: 1 } };
}
function toolCall(id, name, args, raw = false) {
  return { id, type: 'function', function: { name, arguments: raw ? args : JSON.stringify(args) } };
}
function toolResponse(...calls) {
  return { data: { model: models.flash, choices: [{ finish_reason: 'tool_calls',
    message: { role: 'assistant', content: null, tool_calls: calls, reasoning_content: unsafeReasoning } }] },
  metadata: { attempts: 1 } };
}
function broker(id = 'call_broker') {
  return toolResponse(toolCall(id, 'codex_tool', { name: plugin.name, arguments: { key: 'prefix' } }));
}
function isComplete(result) {
  assert.equal(result.state, 'completed', 'task must finish successfully: ' + JSON.stringify(result));
  return result;
}
function isFailed(result) {
  assert.equal(result.state, 'failed', 'runtime failure must be explicit');
  assert.equal(typeof (result.error_code ?? result.error?.code), 'string');
  return result;
}
function collectFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    const details = lstatSync(path);
    return details.isDirectory() && !details.isSymbolicLink() ? collectFiles(path) : [path];
  });
}
function fixture(t, plan, options = {}) {
  const base = mkdtempSync(join(tempRoot, 'codex-deepseek-agent-test-'));
  const stateDir = join(base, 'state');
  const scratchRoot = join(base, 'scratch');
  mkdirSync(stateDir);
  mkdirSync(scratchRoot);
  const calls = [];
  const counters = { configuration: 0, credential: 0 };
  const config = structuredClone(options.configuration ?? configuration);
  const runtime = createAgentRuntime({
    stateDir,
    scratchRoot,
    loadConfig: async () => { counters.configuration++; return structuredClone(config); },
    loadCredential: async () => { counters.credential++; return syntheticCredential; },
    ...(Object.hasOwn(options, 'recordDiagnostic') ? { recordDiagnostic: options.recordDiagnostic } : {}),
    request: async (receivedConfig, endpoint, credential, body, policy, control) => {
      assert.equal(receivedConfig.base_url, configuration.base_url);
      assert.equal(endpoint, '/chat/completions');
      assert.equal(credential, syntheticCredential);
      const index = calls.length;
      calls.push({ body: structuredClone(body), policy: structuredClone(policy), signal: control?.signal });
      const step = typeof plan === 'function' ? plan(index, body, policy) : plan[index];
      assert.notEqual(step, undefined, 'the runtime must not make an unplanned provider request');
      return await step;
    },
  });
  t.after(async () => {
    await runtime.dispose();
    // This is the test-owned absolute temporary directory, never a computed
    // workspace or user state directory. Links inside are not followed by rm.
    const actual = realpathSync(base);
    const scoped = relative(tempRoot, actual);
    assert.ok(actual === resolve(base) && scoped && !isAbsolute(scoped) && scoped !== '..'
      && !scoped.startsWith('..' + sep) && basename(actual).startsWith('codex-deepseek-agent-test-'));
    rmSync(actual, { recursive: true, force: true });
  });
  return { runtime, base, scratchRoot, stateDir, calls, counters };
}
function baseInput(extra = {}) {
  return { task: 'Build the explicitly requested synthetic artifact.', model: 'flash', ...extra };
}
async function rejectedWithoutRequest(ctx, operation) {
  const before = ctx.calls.length;
  await assert.rejects(operation);
  assert.equal(ctx.calls.length, before, 'invalid input must not cause another provider request');
}

test('agent completes a text task without returning credentials or hidden reasoning', async t => {
  const ctx = fixture(t, [completion('Ready.')]);
  const result = isComplete(await ctx.runtime.start(baseInput()));
  assert.equal(result.answer, 'Ready.');
  assert.equal(result.model, 'flash');
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].body.model, models.flash);
  assert.equal(ctx.calls[0].body.max_tokens, 4096);
  assert.equal(result.steps, 1);
  assert.equal(result.tool_calls, 0);
  assert.equal(ctx.counters.credential, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(syntheticCredential + '|' + unsafeReasoning));
});
test('multi-step file production crosses the Codex broker and returns executable hashed artifacts', async t => {
  const source = JSON.stringify([{ id: 7, name: 'Ada' }, { id: 8, name: 'Lin' }]);
  const artifact = 'export const render = rows => rows.map(row => `Hello ${row.name} (#${row.id})`).join("\\n");\n';
  const ctx = fixture(t, (index, body) => {
    if (index === 0) return toolResponse(toolCall('call_list', 'list_files', {}),
      toolCall('call_read', 'read_file', { path: 'input/rows.json' }));
    if (index === 1) {
      const tools = body.messages.filter(message => message.role === 'tool');
      assert.equal(tools.length, 2);
      assert.ok(tools.some(message => message.content.includes('input/rows.json')));
      assert.ok(tools.some(message => message.content.includes('Ada')));
      return broker();
    }
    if (index === 2) {
      assert.ok(body.messages.some(message => message.role === 'tool' && message.content.includes('Hello')),
        'the model must receive the explicitly supplied broker result');
      return toolResponse(toolCall('call_write', 'write_file', { path: 'dist/render.mjs', content: artifact }));
    }
    if (index === 3) return completion('Created dist/render.mjs.');
  });
  const waiting = await ctx.runtime.start(baseInput({ files: [{ path: 'input/rows.json', content: source }], plugin_tools: [plugin] }));
  assert.equal(waiting.state, 'waiting_for_tools', JSON.stringify(waiting));
  assert.equal(ctx.calls.length, 2, 'the runtime must pause instead of executing the plugin itself');
  assert.equal(waiting.requests.length, 1);
  assert.equal(waiting.requests[0].tool_name, plugin.name);
  assert.deepEqual(waiting.requests[0].arguments, { key: 'prefix' });
  const ready = isComplete(await ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: waiting.requests[0].request_id, result: { prefix: 'Hello' } }] }));
  assert.equal(ctx.calls.length, 4);
  const produced = ready.artifacts.find(item => item.path === 'dist/render.mjs');
  assert.ok(produced, 'the produced file must be included in the artifact manifest');
  assert.equal(produced.content, artifact);
  assert.equal(produced.sha256, createHash('sha256').update(artifact).digest('hex'));
  const module = await import('data:text/javascript;base64,' + Buffer.from(produced.content).toString('base64'));
  assert.equal(module.render(JSON.parse(source)), 'Hello Ada (#7)\nHello Lin (#8)');
  for (const call of ctx.calls) assert.equal(call.body.model, models.flash);
  const status = await ctx.runtime.status({ task_id: waiting.task_id });
  assert.equal(status.state, 'completed');
  assert.doesNotMatch(JSON.stringify(ready), new RegExp(syntheticCredential + '|' + unsafeReasoning));
});

test('resume rejects unknown, incomplete, duplicate, and stale results without consuming the task', async t => {
  const ctx = fixture(t, [toolResponse(
    toolCall('call_first', 'codex_tool', { name: plugin.name, arguments: { key: 'one' } }),
    toolCall('call_second', 'codex_tool', { name: plugin.name, arguments: { key: 'two' } })), completion('Both received.')]);
  const waiting = await ctx.runtime.start(baseInput({ plugin_tools: [plugin] }));
  const [first, second] = waiting.requests;
  await rejectedWithoutRequest(ctx, () => ctx.runtime.resume({ task_id: waiting.task_id, results: [] }));
  await rejectedWithoutRequest(ctx, () => ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: first.request_id, result: 'one' }] }));
  await rejectedWithoutRequest(ctx, () => ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: first.request_id, result: 'one' }, { request_id: first.request_id, result: 'again' }] }));
  await rejectedWithoutRequest(ctx, () => ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: first.request_id, result: 'one' }, { request_id: 'unissued-request', result: 'two' }] }));
  assert.equal((await ctx.runtime.status({ task_id: waiting.task_id })).state, 'waiting_for_tools');
  const results = [{ request_id: second.request_id, result: 'two' }, { request_id: first.request_id, result: 'one' }];
  isComplete(await ctx.runtime.resume({ task_id: waiting.task_id, results }));
  await rejectedWithoutRequest(ctx, () => ctx.runtime.resume({ task_id: waiting.task_id, results }));
});

test('a second broker round requires its new request IDs', async t => {
  const ctx = fixture(t, [broker('call_one'), broker('call_two'), completion()]);
  const first = await ctx.runtime.start(baseInput({ plugin_tools: [plugin] }));
  const firstResult = [{ request_id: first.requests[0].request_id, result: 'first' }];
  const second = await ctx.runtime.resume({ task_id: first.task_id, results: firstResult });
  assert.equal(second.state, 'waiting_for_tools');
  assert.notEqual(second.requests[0].request_id, first.requests[0].request_id);
  await rejectedWithoutRequest(ctx, () => ctx.runtime.resume({ task_id: first.task_id, results: firstResult }));
  isComplete(await ctx.runtime.resume({ task_id: first.task_id,
    results: [{ request_id: second.requests[0].request_id, result: 'second' }] }));
});

test('a valid mixed local and broker batch preserves tool-result order across the pause', async t => {
  const ctx = fixture(t, (index, body) => {
    if (index === 0) return toolResponse(
      toolCall('call_local', 'write_file', { path: 'draft.txt', content: 'SYNTHETIC-DRAFT' }),
      toolCall('call_broker', 'codex_tool', { name: plugin.name, arguments: { key: 'prefix' } }));
    if (index === 1) {
      const results = body.messages.filter(message => message.role === 'tool');
      assert.deepEqual(results.map(message => message.tool_call_id), ['call_local', 'call_broker']);
      assert.ok(results[0].content.includes('draft.txt'));
      assert.ok(results[1].content.includes('SYNTHETIC-HOST-RESULT'));
      return completion();
    }
  });
  const waiting = await ctx.runtime.start(baseInput({ plugin_tools: [plugin] }));
  assert.equal(waiting.state, 'waiting_for_tools');
  assert.equal(waiting.requests.length, 1);
  assert.equal(ctx.calls.length, 1);
  const done = isComplete(await ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: waiting.requests[0].request_id, result: 'SYNTHETIC-HOST-RESULT' }] }));
  assert.equal(done.artifacts.find(item => item.path === 'draft.txt')?.content, 'SYNTHETIC-DRAFT');
});

test('waiting broker requests expose changed file artifacts for host review with stable hashes', async t => {
  const input = 'SYNTHETIC-UNCHANGED-INPUT\n';
  const content = 'export const answer = 42;\n';
  const expected = [{ path: 'dist/answer.mjs', content,
    sha256: createHash('sha256').update(content).digest('hex') }];
  const ctx = fixture(t, [toolResponse(
    toolCall('call_read', 'read_file', { path: 'input.txt' }),
    toolCall('call_write', 'write_file', { path: 'dist/answer.mjs', content }),
    toolCall('call_review', 'codex_tool', { name: plugin.name, arguments: { key: 'review' } })),
  completion('The host reviewed the generated file.')]);
  const waiting = await ctx.runtime.start(baseInput({
    files: [{ path: 'input.txt', content: input }], plugin_tools: [plugin],
  }));
  assert.equal(waiting.state, 'waiting_for_tools');
  assert.equal(waiting.requests.length, 1);
  assert.equal(ctx.calls.length, 1, 'host review must occur before another provider request');
  assert.deepEqual(waiting.artifacts, expected, 'pending artifacts must include exact changed content and hash, excluding unchanged inputs');
  assert.equal((await ctx.runtime.status({ task_id: waiting.task_id })).state, 'waiting_for_tools');
  const done = isComplete(await ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: waiting.requests[0].request_id, result: { accepted: true } }] }));
  assert.deepEqual(done.artifacts, expected, 'completion must preserve the artifact reviewed during the broker pause');
  assert.equal(ctx.calls.length, 2);
});

test('a malformed mixed batch never exposes an earlier broker request as pending', async t => {
  const ctx = fixture(t, [toolResponse(
    toolCall('call_broker', 'codex_tool', { name: plugin.name, arguments: { key: 'prefix' } }),
    toolCall('call_bad', 'write_file', '{broken', true))]);
  const failed = isFailed(await ctx.runtime.start(baseInput({ plugin_tools: [plugin] })));
  assert.equal(failed.requests, undefined);
  assert.equal((await ctx.runtime.status({ task_id: failed.task_id })).requests, undefined);
  assert.equal(ctx.calls.length, 1);
  assert.equal(collectFiles(ctx.scratchRoot).length, 0);
});

test('Pro selection uses its exact configured ID without changing later model requests', async t => {
  const ctx = fixture(t, [toolResponse(toolCall('call_list', 'list_files', {})), completion()]);
  const result = isComplete(await ctx.runtime.start(baseInput({ model: 'pro' })));
  assert.equal(result.model, 'pro');
  assert.deepEqual(ctx.calls.map(call => call.body.model), [models.pro, models.pro]);
});

test('missing Pro configuration never silently selects Flash', async t => {
  const config = structuredClone(configuration);
  delete config.models.pro;
  const ctx = fixture(t, [], { configuration: config });
  assert.equal(isFailed(await ctx.runtime.start(baseInput({ model: 'pro' }))).error_code, 'model_unavailable');
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.counters.credential, 0);
});

test('an unavailable selected model fails once without switching models or replaying', async t => {
  const ctx = fixture(t, () => { const error = new Error('Synthetic unavailable model.'); error.code = 'model_unavailable'; throw error; });
  const result = isFailed(await ctx.runtime.start(baseInput({ model: 'pro' })));
  assert.equal(result.model, 'pro');
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].body.model, models.pro);
});

test('provider tool definitions include the allowlisted plugin descriptions and argument schemas', async t => {
  const ctx = fixture(t, [completion()]);
  isComplete(await ctx.runtime.start(baseInput({ plugin_tools: [plugin] })));
  const tools = JSON.stringify(ctx.calls[0].body.tools);
  assert.ok(tools.includes(plugin.description));
  assert.ok(tools.includes('"required":["key"]'));
  assert.ok(tools.includes('"key":{"type":"string"}'));
});

for (const [label, badCall] of [
  ['malformed JSON', toolCall('call_bad', 'read_file', '{broken', true)],
  ['unknown function', toolCall('call_bad', 'execute_shell', { command: 'synthetic' })],
  ['unadvertised broker tool', toolCall('call_bad', 'codex_tool', { name: 'unadvertised_tool', arguments: {} })],
  ['wrong argument type', toolCall('call_bad', 'write_file', { path: 'bad.txt', content: 42 })],
  ['duplicate call ID', toolCall('call_write', 'list_files', {})],
]) {
  test(`an entire tool batch is refused before local effects: ${label}`, async t => {
    const ctx = fixture(t, [toolResponse(toolCall('call_write', 'write_file', { path: 'must-not-exist.txt', content: 'SYNTHETIC' }), badCall)]);
    isFailed(await ctx.runtime.start(baseInput({ plugin_tools: [plugin] })));
    assert.equal(ctx.calls.length, 1);
    assert.equal(collectFiles(ctx.scratchRoot).length, 0, 'no earlier write in an invalid batch may take effect');
  });
}

for (const path of ['../outside.txt', '/outside.txt', 'C:\\outside.txt', '\\\\server\\share\\outside.txt', 'C:outside.txt', 'file.txt:stream']) {
  test(`file tools refuse a path outside the assigned scratch namespace: ${JSON.stringify(path)}`, async t => {
    const ctx = fixture(t, [toolResponse(toolCall('call_write', 'write_file', { path, content: 'SYNTHETIC' }))]);
    isFailed(await ctx.runtime.start(baseInput()));
    assert.equal(ctx.calls.length, 1);
    assert.equal(collectFiles(ctx.scratchRoot).length, 0);
    assert.ok(!existsSync(join(ctx.base, 'outside.txt')));
  });
}

test('explicit inputs are copied to unique tasks without reading other workspace files', async t => {
  const ctx = fixture(t, [toolResponse(toolCall('call_read', 'read_file', { path: 'ambient.txt' })), completion()]);
  writeFileSync(join(ctx.base, 'ambient.txt'), 'SYNTHETIC-UNSHARED-AMBIENT-CONTENT');
  const first = isFailed(await ctx.runtime.start(baseInput({ files: [{ path: 'input.txt', content: 'explicit' }] })));
  assert.equal(ctx.calls.length, 1, 'the missing file must be refused by the read tool, after the model requests it');
  const second = isComplete(await ctx.runtime.start(baseInput({ files: [{ path: 'input.txt', content: 'different' }] })));
  assert.notEqual(first.task_id, second.task_id);
  const copies = collectFiles(ctx.scratchRoot).filter(path => basename(path) === 'input.txt');
  assert.equal(copies.length, 2);
  assert.deepEqual(copies.map(path => readFileSync(path, 'utf8')).sort(), ['different', 'explicit']);
  assert.doesNotMatch(JSON.stringify(first), /SYNTHETIC-UNSHARED-AMBIENT-CONTENT/);
});

for (const kind of ['symlink', 'hardlink']) {
  test(`file reads refuse a ${kind} inserted into task scratch`, async t => {
    const ctx = fixture(t, [broker(), toolResponse(toolCall('call_read', 'read_file', { path: 'leak.txt' }))]);
    const outside = join(ctx.base, 'outside-owned.txt');
    writeFileSync(outside, 'SYNTHETIC-UNSHARED-LINK-CONTENT');
    const waiting = await ctx.runtime.start(baseInput({ files: [{ path: 'input.txt', content: 'input' }], plugin_tools: [plugin] }));
    assert.equal(waiting.state, 'waiting_for_tools', JSON.stringify(waiting));
    const seed = collectFiles(ctx.scratchRoot).find(path => basename(path) === 'input.txt');
    assert.ok(seed);
    const link = join(dirname(seed), 'leak.txt');
    try {
      if (kind === 'hardlink') linkSync(outside, link);
      else symlinkSync(outside, link, 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) { t.skip('This filesystem does not permit test links.'); return; }
      throw error;
    }
    const failed = isFailed(await ctx.runtime.resume({ task_id: waiting.task_id,
      results: [{ request_id: waiting.requests[0].request_id, result: 'synthetic' }] }));
    assert.equal(failed.error_code, 'path_refused');
    assert.doesNotMatch(JSON.stringify(failed), /SYNTHETIC-UNSHARED-LINK-CONTENT/);
    assert.equal(readFileSync(outside, 'utf8'), 'SYNTHETIC-UNSHARED-LINK-CONTENT');
  });
}

test('step budget is shared across broker continuation instead of resetting', async t => {
  const ctx = fixture(t, [broker()]);
  const waiting = await ctx.runtime.start(baseInput({ plugin_tools: [plugin], max_steps: 1 }));
  const failed = isFailed(await ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: waiting.requests[0].request_id, result: 'synthetic' }] }));
  assert.equal(failed.error_code, 'step_limit');
  assert.equal(ctx.calls.length, 1);
});

for (const code of ['request_failed', 'step_limit', 'answer_truncated']) {
  test(`failed tasks preserve committed changed artifacts without changing ${code}`, async t => {
    const entries = [];
    const ctx = fixture(t, index => {
      if (index === 0) return toolResponse(
        toolCall('call_new', 'write_file', { path: 'draft.txt', content: 'COMMITTED-NEW' }),
        toolCall('call_changed', 'write_file', { path: 'input.txt', content: 'COMMITTED-CHANGED' }));
      if (code === 'request_failed') throw Object.assign(new Error('SYNTHETIC-RAW-FAILURE'), { code });
      const response = completion('SYNTHETIC-TRUNCATED-CONTENT');
      response.data.choices[0].finish_reason = 'length';
      return response;
    }, { recordDiagnostic: async (_stateDir, action, model, result) => {
      entries.push(structuredClone({ action, model, result }));
    } });
    const failed = isFailed(await ctx.runtime.start(baseInput({
      task: 'SYNTHETIC-PRIVATE-RECOVERY-TASK', reasoning_effort: 'max',
      max_steps: code === 'step_limit' ? 1 : 3,
      files: [{ path: 'input.txt', content: 'ORIGINAL-INPUT' },
        { path: 'untouched.txt', content: 'ORIGINAL-UNCHANGED' }],
    })));
    assert.equal(failed.error_code, code);
    assert.equal(failed.answer, undefined);
    assert.deepEqual(failed.artifacts, [
      { path: 'draft.txt', content: 'COMMITTED-NEW',
        sha256: createHash('sha256').update('COMMITTED-NEW').digest('hex') },
      { path: 'input.txt', content: 'COMMITTED-CHANGED',
        sha256: createHash('sha256').update('COMMITTED-CHANGED').digest('hex') },
    ]);
    const taskEntries = entries.filter(entry => entry.action === 'agent_task');
    assert.equal(taskEntries.length, 1);
    const task = taskEntries[0].result;
    assert.deepEqual(Object.keys(task).sort(), ['ok', 'state', 'transport_mode', 'task_id_hash', 'reasoning_effort',
      'total_timeout_ms', 'max_output_tokens', 'minimum_output_tokens', 'max_steps', 'max_tool_calls', 'max_http_attempts',
      'steps', 'tool_calls', 'http_attempts', 'error_code', 'last_response', 'budget_exhaustion',
      'artifact_count', 'elapsed_ms'].sort());
    assert.equal(task.state, 'failed');
    assert.equal(task.error_code, code);
    assert.equal(task.reasoning_effort, 'max');
    assert.equal(task.artifact_count, 2);
    assert.equal(task.http_attempts, ctx.calls.length);
    assert.equal(task.task_id_hash, 'sha256:' + createHash('sha256').update(failed.task_id).digest('hex').slice(0, 16));
    assert.doesNotMatch(JSON.stringify(entries), /SYNTHETIC-PRIVATE-RECOVERY-TASK|SYNTHETIC-RAW-FAILURE|COMMITTED-|ORIGINAL-|draft\.txt|input\.txt|untouched\.txt|SYNTHETIC-HIDDEN-REASONING|sk-SYNTHETIC-AGENT/);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal((await ctx.runtime.status({ task_id: failed.task_id })).elapsed_ms, failed.elapsed_ms);
    assert.equal((await ctx.runtime.cancel({ task_id: failed.task_id })).elapsed_ms, failed.elapsed_ms);
    assert.equal(entries.filter(entry => entry.action === 'agent_task').length, 1);
    assert.equal(ctx.calls.length, code === 'step_limit' ? 1 : 2);
  });
}

test('an earlier committed write survives a later local tool failure in the same batch', async t => {
  const ctx = fixture(t, [toolResponse(
    toolCall('call_write', 'write_file', { path: 'draft.txt', content: 'COMMITTED-DRAFT' }),
    toolCall('call_missing', 'read_file', { path: 'missing.txt' }))]);
  const failed = isFailed(await ctx.runtime.start(baseInput()));
  assert.equal(failed.error_code, 'file_unavailable');
  assert.equal(failed.artifacts[0]?.content, 'COMMITTED-DRAFT');
  assert.equal(ctx.calls.length, 1);
});

test('Windows artifact recovery matches committed paths across directory casing and excludes baseline content', async t => {
  if (process.platform !== 'win32') { t.skip('Directory casing equivalence is Windows-specific.'); return; }
  for (const content of ['COMMITTED-CHANGED', 'ORIGINAL-INPUT']) {
    const ctx = fixture(t, [toolResponse(
      toolCall('call_write', 'write_file', { path: 'input/rows.txt', content }))]);
    const failed = isFailed(await ctx.runtime.start(baseInput({ max_steps: 1,
      files: [{ path: 'Input/rows.txt', content: 'ORIGINAL-INPUT' }] })));
    assert.equal(failed.error_code, 'step_limit');
    assert.deepEqual(failed.artifacts, content === 'ORIGINAL-INPUT' ? [] : [{
      path: 'Input/rows.txt', content, sha256: createHash('sha256').update(content).digest('hex'),
    }]);
    assert.equal(ctx.calls.length, 1);
  }
});

for (const kind of ['modified', 'oversized', 'total_budget', 'symlink', 'hardlink']) {
  test(`failure recovery refuses ${kind} scratch contents and retains the original failure`, async t => {
    const ctx = fixture(t, index => {
      if (index === 0) return toolResponse(
        toolCall('call_write', 'write_file', { path: 'draft.txt', content: 'COMMITTED-DRAFT' }),
        toolCall('call_broker', 'codex_tool', { name: plugin.name, arguments: { key: 'prefix' } }));
      throw Object.assign(new Error('Synthetic request failure.'), { code: 'request_failed' });
    });
    const waiting = await ctx.runtime.start(baseInput({ plugin_tools: [plugin] }));
    assert.equal(waiting.artifacts[0]?.content, 'COMMITTED-DRAFT');
    const draft = collectFiles(ctx.scratchRoot).find(path => basename(path) === 'draft.txt');
    if (kind === 'modified') writeFileSync(draft, 'SYNTHETIC-UNCOMMITTED-CONTENT');
    else if (kind === 'oversized') writeFileSync(draft, 'X'.repeat(64 * 1024 + 1));
    else if (kind === 'total_budget') writeFileSync(join(dirname(draft), 'extra.txt'), 'X'.repeat(128 * 1024));
    else {
      const outside = join(ctx.base, 'outside-owned.txt');
      writeFileSync(outside, 'SYNTHETIC-UNSHARED-LINK-CONTENT');
      rmSync(draft);
      try {
        if (kind === 'hardlink') linkSync(outside, draft);
        else symlinkSync(outside, draft, 'file');
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) { t.skip('This filesystem does not permit test links.'); return; }
        throw error;
      }
    }
    const failed = isFailed(await ctx.runtime.resume({ task_id: waiting.task_id,
      results: [{ request_id: waiting.requests[0].request_id, result: 'synthetic' }] }));
    assert.equal(failed.error_code, 'request_failed', 'artifact inspection must not mask the provider failure');
    assert.deepEqual(failed.artifacts, [], 'stale broker manifests and unsafe recovery contents must be discarded');
    assert.doesNotMatch(JSON.stringify(failed), /SYNTHETIC-UNCOMMITTED-CONTENT|SYNTHETIC-UNSHARED-LINK-CONTENT/);
    assert.equal(ctx.calls.length, 2);
  });
}

for (const finish of ['length', 'max_tokens', 'max_output_tokens']) {
  for (const shape of ['text', 'tools']) {
    test(`${shape} output marked ${finish} is classified as answer_truncated`, async t => {
      const response = shape === 'text' ? completion('Incomplete text.')
        : toolResponse(toolCall('call_write', 'write_file', { path: 'partial.txt', content: 'MUST-NOT-WRITE' }));
      response.data.choices[0].finish_reason = finish;
      const ctx = fixture(t, [response]);
      const failed = isFailed(await ctx.runtime.start(baseInput()));
      assert.equal(failed.error_code, 'answer_truncated');
      assert.deepEqual(failed.artifacts, []);
      assert.equal(collectFiles(ctx.scratchRoot).length, 0);
      assert.equal(ctx.calls.length, 1);
    });
  }
}

test('tool call budget rejects an entire over-budget batch before the first write', async t => {
  const ctx = fixture(t, [toolResponse(toolCall('call_one', 'write_file', { path: 'one.txt', content: 'one' }),
    toolCall('call_two', 'write_file', { path: 'two.txt', content: 'two' }))]);
  assert.equal(isFailed(await ctx.runtime.start(baseInput({ max_tool_calls: 1 }))).error_code, 'tool_limit');
  assert.equal(collectFiles(ctx.scratchRoot).length, 0);
  assert.equal(ctx.calls.length, 1);
});

test('the total deadline includes time spent waiting for the Codex broker', async t => {
  const ctx = fixture(t, [broker()]);
  const waiting = await ctx.runtime.start(baseInput({ plugin_tools: [plugin], total_timeout_ms: 80 }));
  assert.equal(waiting.state, 'waiting_for_tools');
  await new Promise(resolve => setTimeout(resolve, 110));
  const expired = await ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: waiting.requests[0].request_id, result: 'synthetic' }] });
  isFailed(expired);
  assert.equal(expired.error_code, 'deadline_exceeded');
  assert.equal(ctx.calls.length, 1, 'expired work must not receive a fresh request budget');
});

test('later requests receive only the remaining shared deadline', async t => {
  const ctx = fixture(t, async index => {
    if (index === 0) { await new Promise(resolve => setTimeout(resolve, 25)); return toolResponse(toolCall('call_list', 'list_files', {})); }
    if (index === 1) return completion();
  });
  isComplete(await ctx.runtime.start(baseInput({ total_timeout_ms: 1000 })));
  assert.ok(ctx.calls[1].policy.totalTimeoutMs < ctx.calls[0].policy.totalTimeoutMs);
  assert.ok(ctx.calls[1].policy.totalTimeoutMs < 990);
});

test('cancellation of a waiting task prevents any continuation', async t => {
  const ctx = fixture(t, [broker()]);
  const waiting = await ctx.runtime.start(baseInput({ plugin_tools: [plugin] }));
  const cancelled = await ctx.runtime.cancel({ task_id: waiting.task_id });
  assert.equal(cancelled.state, 'cancelled');
  await rejectedWithoutRequest(ctx, () => ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: waiting.requests[0].request_id, result: 'late' }] }));
  assert.equal((await ctx.runtime.status({ task_id: waiting.task_id })).state, 'cancelled');
});

test('in-flight cancellation is honest and prevents effects after a late provider response', async t => {
  let release;
  let entered;
  const enteredRequest = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const ctx = fixture(t, index => {
    if (index === 0) return broker();
    if (index === 1) { entered(); return delayed; }
  });
  const waiting = await ctx.runtime.start(baseInput({ plugin_tools: [plugin] }));
  const running = ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: waiting.requests[0].request_id, result: 'continue' }] });
  await enteredRequest;
  const cancellation = await ctx.runtime.cancel({ task_id: waiting.task_id });
  assert.ok(['cancelling', 'cancelled'].includes(cancellation.state));
  assert.ok(ctx.calls[1].signal instanceof AbortSignal);
  assert.equal(ctx.calls[1].signal.aborted, true, 'cancellation must reach transport retry/backoff control');
  assert.equal(ctx.calls[1].policy.signal, undefined, 'AbortSignal travels outside the serializable request policy');
  release(toolResponse(toolCall('call_late', 'write_file', { path: 'too-late.txt', content: 'must not write' })));
  assert.equal((await running).state, 'cancelled');
  assert.equal((await ctx.runtime.status({ task_id: waiting.task_id })).state, 'cancelled');
  assert.equal(ctx.calls.length, 2);
  assert.equal(collectFiles(ctx.scratchRoot).length, 0);
});

for (const cancellation of ['abort', 'dispose']) {
  test(`${cancellation} propagates to an in-flight request and logs cancellation only after it settles`, async t => {
    let release;
    let entered;
    const begun = new Promise(resolve => { entered = resolve; });
    const delayed = new Promise(resolve => { release = resolve; });
    const entries = [];
    const ctx = fixture(t, index => index === 0 ? broker() : (entered(), delayed), {
      recordDiagnostic: async (_stateDir, action, _model, result) => {
        entries.push(structuredClone({ action, result }));
      },
    });
    const external = new AbortController();
    const waiting = await ctx.runtime.start(baseInput({ plugin_tools: [plugin] }));
    const running = ctx.runtime.resume({ task_id: waiting.task_id,
      results: [{ request_id: waiting.requests[0].request_id, result: 'continue' }] },
    { signal: external.signal });
    await begun;
    if (cancellation === 'abort') external.abort();
    else await ctx.runtime.dispose();
    assert.equal(ctx.calls[1].signal.aborted, true);
    assert.equal(entries.filter(entry => entry.action === 'agent_task').length, 0,
      'an in-flight task must remain cancelling until the request settles');
    release(completion('Late answer.'));
    const cancelled = await running;
    assert.equal(cancelled.state, 'cancelled');
    const tasks = entries.filter(entry => entry.action === 'agent_task');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].result.state, 'cancelled');
    assert.equal(tasks[0].result.ok, false);
    assert.equal(tasks[0].result.elapsed_ms, cancelled.elapsed_ms);
    await new Promise(resolve => setTimeout(resolve, 15));
    if (cancellation === 'abort') {
      assert.equal((await ctx.runtime.status({ task_id: cancelled.task_id })).elapsed_ms, cancelled.elapsed_ms);
      await ctx.runtime.cancel({ task_id: cancelled.task_id });
    }
    await ctx.runtime.dispose();
    assert.equal(entries.filter(entry => entry.action === 'agent_task').length, 1);
    assert.equal(ctx.calls.length, 2);
  });
}

test('overlapping terminal status, cancel and dispose share one task diagnostic and frozen elapsed time', async t => {
  let entered;
  let release;
  const logging = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const entries = [];
  const ctx = fixture(t, [broker(), completion()], {
    recordDiagnostic: async (_stateDir, action, _model, result) => {
      entries.push(structuredClone({ action, result }));
      if (action === 'agent_task') { entered(); await held; }
    },
  });
  const waiting = await ctx.runtime.start(baseInput({ plugin_tools: [plugin] }));
  const running = ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: waiting.requests[0].request_id, result: 'continue' }] });
  await logging;
  const status = ctx.runtime.status({ task_id: waiting.task_id });
  const cancel = ctx.runtime.cancel({ task_id: waiting.task_id });
  const dispose = ctx.runtime.dispose();
  await new Promise(resolve => setTimeout(resolve, 15));
  release();
  const [completed, observed, cancelled] = await Promise.all([running, status, cancel, dispose]);
  isComplete(completed);
  assert.equal(observed.state, 'completed');
  assert.equal(cancelled.state, 'completed');
  assert.equal(observed.elapsed_ms, completed.elapsed_ms);
  assert.equal(cancelled.elapsed_ms, completed.elapsed_ms);
  const tasks = entries.filter(entry => entry.action === 'agent_task');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].result.elapsed_ms, completed.elapsed_ms);
  assert.equal(ctx.calls.length, 2);
});

test('disposal during expired-task logging prevents a concurrent start from reaching credentials or HTTP', async t => {
  let entered;
  let release;
  const logging = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const entries = [];
  const ctx = fixture(t, index => index === 0 ? broker() : completion(), {
    recordDiagnostic: async (_stateDir, action, _model, result) => {
      entries.push(structuredClone({ action, result }));
      if (action === 'agent_task') { entered(); await held; }
    },
  });
  const waiting = await ctx.runtime.start(baseInput({ plugin_tools: [plugin], total_timeout_ms: 100 }));
  assert.equal(waiting.state, 'waiting_for_tools');
  await new Promise(resolve => setTimeout(resolve, 130));
  const starting = ctx.runtime.start(baseInput());
  await logging;
  const disposing = ctx.runtime.dispose();
  release();
  await assert.rejects(starting, error => error.code === 'runtime_disposed');
  await disposing;
  assert.equal(ctx.counters.configuration, 1);
  assert.equal(ctx.counters.credential, 1);
  assert.equal(ctx.calls.length, 1);
  assert.equal(entries.filter(entry => entry.action === 'agent_task').length, 1);
});

test('running tasks reject simultaneous continuations without another provider request', async t => {
  let release;
  let entered;
  const begun = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const ctx = fixture(t, index => index === 0 ? broker() : (entered(), delayed));
  const waiting = await ctx.runtime.start(baseInput({ plugin_tools: [plugin] }));
  const input = { task_id: waiting.task_id, results: [{ request_id: waiting.requests[0].request_id, result: 'one' }] };
  const first = ctx.runtime.resume(input);
  await begun;
  await rejectedWithoutRequest(ctx, () => ctx.runtime.resume(input));
  release(completion());
  isComplete(await first);
  assert.equal(ctx.calls.length, 2);
});

test('untrusted provider failures never leak raw errors, prompts, or credentials', async t => {
  const privateTask = 'SYNTHETIC-PRIVATE-TASK-MARKER';
  const ctx = fixture(t, () => { throw new Error('SYNTHETIC-RAW-PROVIDER-FAILURE ' + syntheticCredential + ' ' + privateTask); });
  const failed = isFailed(await ctx.runtime.start(baseInput({ task: privateTask })));
  const visible = JSON.stringify([failed, await ctx.runtime.status({ task_id: failed.task_id })]);
  assert.doesNotMatch(visible, /SYNTHETIC-RAW-PROVIDER-FAILURE|SYNTHETIC-PRIVATE-TASK-MARKER|sk-SYNTHETIC-AGENT/);
  const diagnosticFiles = collectFiles(ctx.stateDir).filter(path => /diagnostic/i.test(path));
  for (const path of diagnosticFiles) assert.doesNotMatch(readFileSync(path, 'utf8'),
    /SYNTHETIC-RAW-PROVIDER-FAILURE|SYNTHETIC-PRIVATE-TASK-MARKER|sk-SYNTHETIC-AGENT/);
});

for (const [label, code, network, transportCode] of [
  ['transport error', 'request_failed', { attempts: 1, elapsed_ms: 27, http_status: null,
    error_category: 'transport', transport_code: 'ECONNRESET' }, 'ECONNRESET'],
  ['HTTP retry exhaustion', 'api_http_error', { attempts: 3, elapsed_ms: 73, http_status: 503,
    error_category: 'http_status' }, undefined],
  ['untrusted transport code', 'request_failed', { attempts: 1, elapsed_ms: 27, http_status: null,
    error_category: 'transport' }, 'SYNTHETIC-UNSAFE-TRANSPORT-CODE'],
]) {
  test(`failed steps expose safe network metadata without replay: ${label}`, async t => {
    const privateTask = 'SYNTHETIC-PRIVATE-DIAGNOSTIC-TASK';
    const rawRequestId = 'SYNTHETIC-RAW-REQUEST-ID';
    const rawDetail = 'SYNTHETIC-RAW-DIAGNOSTIC-DETAIL';
    const entries = [];
    const error = Object.assign(new Error(rawDetail + ' ' + syntheticCredential), { code, metadata: {
      ...network, transport_code: transportCode, request_id: rawRequestId,
      body: rawDetail, prompt: privateTask, authorization: syntheticCredential,
      arbitrary: { nested: [rawDetail, syntheticCredential] },
      attempt_history: [{ attempt: network.attempts, status: network.http_status,
        category: network.error_category, delay_ms: 0, elapsed_ms: network.elapsed_ms,
        request_id: rawRequestId, body: rawDetail }],
    } });
    const ctx = fixture(t, () => { throw error; }, {
      recordDiagnostic: async (stateDir, action, model, result, promptPath) => {
        entries.push(structuredClone({ stateDir, action, model, result, promptPath }));
      },
    });
    const failed = isFailed(await ctx.runtime.start(baseInput({ task: privateTask })));
    const status = await ctx.runtime.status({ task_id: failed.task_id });
    assert.equal(failed.error_code, code);
    assert.deepEqual(failed.network, network);
    assert.equal(failed.http_attempts, network.attempts);
    assert.equal(status.http_attempts, network.attempts);
    assert.equal(failed.steps, 1);
    assert.equal(ctx.calls.length, 1, 'runtime diagnostics must not replay a failed provider step');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].stateDir, ctx.stateDir);
    assert.equal(entries[0].action, 'agent_step');
    assert.equal(entries[0].model, 'flash');
    assert.equal(entries[0].result.ok, false);
    assert.equal(entries[0].result.attempts, network.attempts);
    assert.equal(entries[0].result.request_id, undefined);
    assert.match(entries[0].result.request_id_hash, /^sha256:[0-9a-f]{16}$/);
    assert.equal(entries[1].action, 'agent_task');
    assert.equal(entries[1].result.state, 'failed');
    assert.equal(entries[1].result.error_code, code);
    assert.equal(entries[1].result.http_attempts, network.attempts);
    assert.match(entries[1].result.task_id_hash, /^sha256:[0-9a-f]{16}$/);
    assert.ok(!JSON.stringify(entries[1]).includes(failed.task_id));
    assert.doesNotMatch(JSON.stringify([failed, status, entries]),
      /SYNTHETIC-PRIVATE-DIAGNOSTIC-TASK|SYNTHETIC-RAW-REQUEST-ID|SYNTHETIC-RAW-DIAGNOSTIC-DETAIL|SYNTHETIC-UNSAFE-TRANSPORT-CODE|sk-SYNTHETIC-AGENT/);
  });
}

test('a successful broker step is logged once without implying task completion', async t => {
  const entries = [];
  const ctx = fixture(t, [broker(), completion()], {
    recordDiagnostic: async (stateDir, action, model, result) => {
      entries.push(structuredClone({ stateDir, action, model, result }));
    },
  });
  const waiting = await ctx.runtime.start(baseInput({ plugin_tools: [plugin] }));
  assert.equal(waiting.state, 'waiting_for_tools');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'agent_step');
  assert.equal(entries[0].model, 'flash');
  assert.equal(entries[0].result.ok, true, 'ok describes the returned HTTP step');
  assert.equal(entries[0].result.state, undefined);
  assert.equal(entries[0].result.answer, undefined);
  assert.doesNotMatch(JSON.stringify(entries), /completed|SYNTHETIC-HIDDEN-REASONING|sk-SYNTHETIC-AGENT/);
  const ready = isComplete(await ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: waiting.requests[0].request_id, result: 'synthetic' }] }));
  assert.equal(ready.http_attempts, 2);
  assert.equal(ctx.calls.length, 2);
  assert.equal(entries.length, 3, 'provider steps and the terminal task have separate diagnostic entries');
  assert.equal(entries.filter(entry => entry.action === 'agent_step' && entry.result.ok === true).length, 2);
  assert.equal(entries[2].action, 'agent_task');
  assert.equal(entries[2].result.state, 'completed');
  assert.equal(entries[2].result.ok, true);
});

for (const [label, finish, completionTokens, reasoningTokens, expected] of [
  ['valid', 'stop', 4096, 3584, { finish_reason: 'stop', completion_tokens: 4096, reasoning_tokens: 3584 }],
  ['untrusted strings', 'SYNTHETIC-PRIVATE-FINISH', 'SYNTHETIC-PRIVATE-COUNT', 'SYNTHETIC-PRIVATE-REASONING',
    { finish_reason: null, completion_tokens: null, reasoning_tokens: null }],
  ['invalid integers', 'length', -1, Infinity,
    { finish_reason: 'length', completion_tokens: null, reasoning_tokens: null }],
  ['fractional and unsafe integers', 'max_output_tokens', 1.5, Number.MAX_SAFE_INTEGER + 1,
    { finish_reason: 'max_output_tokens', completion_tokens: null, reasoning_tokens: null }],
]) {
  test(`step diagnostics expose only whitelisted output metadata: ${label}`, async t => {
    const response = completion();
    response.data.choices[0].finish_reason = finish;
    response.data.usage = { completion_tokens: completionTokens,
      completion_tokens_details: { reasoning_tokens: reasoningTokens, reasoning: unsafeReasoning },
      prompt: 'SYNTHETIC-PRIVATE-USAGE-PROMPT', authorization: syntheticCredential };
    const entries = [];
    const ctx = fixture(t, [response], {
      recordDiagnostic: async (_stateDir, action, _model, result) => {
        entries.push(structuredClone({ action, result }));
      },
    });
    await ctx.runtime.start(baseInput());
    const step = entries.find(entry => entry.action === 'agent_step').result;
    assert.deepEqual({ finish_reason: step.finish_reason,
      completion_tokens: step.completion_tokens, reasoning_tokens: step.reasoning_tokens }, expected);
    assert.doesNotMatch(JSON.stringify(entries), /SYNTHETIC-PRIVATE-|SYNTHETIC-HIDDEN-REASONING|sk-SYNTHETIC-AGENT/);
    assert.equal(ctx.calls.length, 1);
  });
}

test('injected requests default to no diagnostic filesystem writes', async t => {
  const ctx = fixture(t, index => {
    if (index === 0) return broker();
    throw Object.assign(new Error('Synthetic offline provider failure.'), { code: 'request_failed' });
  });
  const waiting = await ctx.runtime.start(baseInput({ plugin_tools: [plugin] }));
  assert.equal(waiting.state, 'waiting_for_tools');
  assert.deepEqual(collectFiles(ctx.stateDir), []);
  isFailed(await ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: waiting.requests[0].request_id, result: 'synthetic' }] }));
  assert.equal(ctx.calls.length, 2);
  assert.deepEqual(collectFiles(ctx.stateDir), [], 'offline request injection must not enable the production logger');
});

test('production diagnostics preserve agent hashes and hash raw hash-shaped request IDs', async t => {
  const rawRequestId = 'sha256:0123456789abcdef';
  const expectedHash = 'sha256:' + createHash('sha256').update(rawRequestId).digest('hex').slice(0, 16);
  const response = completion();
  response.metadata = { attempts: 1, elapsed_ms: 7, http_status: 200, error_category: null,
    request_id: rawRequestId, attempt_history: [{ attempt: 1, status: 200, category: 'ok',
      delay_ms: 0, elapsed_ms: 7, request_id: rawRequestId }] };
  const ctx = fixture(t, [response], { recordDiagnostic });
  isComplete(await ctx.runtime.start(baseInput()));
  assert.equal(ctx.calls.length, 1);
  // The agent passes an explicit hash; the production logger must preserve it.
  const diagnosticPath = join(ctx.stateDir, 'diagnostics.jsonl');
  const readEntries = () => readFileSync(diagnosticPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const agentEntries = readEntries();
  assert.equal(agentEntries.length, 2);
  assert.equal(agentEntries[0].request_id, expectedHash);
  assert.equal(agentEntries[0].attempt_history[0].request_id, expectedHash);
  // The CLI still passes a raw ID. A hash-shaped value must not bypass hashing,
  // even if an explicit hash is also supplied alongside the raw field.
  await recordDiagnostic(ctx.stateDir, 'agent_step', 'flash', { ...response.metadata, ok: true,
    request_id_hash: rawRequestId, attempt_history: response.metadata.attempt_history.map(item => ({
      ...item, request_id_hash: rawRequestId,
    })) });
  const entries = readEntries();
  assert.equal(entries.length, 3);
  assert.equal(entries[2].request_id, expectedHash);
  assert.equal(entries[2].attempt_history[0].request_id, expectedHash);
  assert.ok(!readFileSync(diagnosticPath, 'utf8').includes(rawRequestId));
});

for (const outcome of ['success', 'failure']) {
  test(`diagnostic logger rejection preserves the requested ${outcome} result`, async t => {
    let diagnosticCalls = 0;
    const error = Object.assign(new Error('Synthetic provider failure.'), {
      code: 'request_failed', metadata: { attempts: 1, elapsed_ms: 11, http_status: null, error_category: 'transport' },
    });
    const ctx = fixture(t, () => { if (outcome === 'failure') throw error; return completion('Ready.'); }, {
      recordDiagnostic: async () => { diagnosticCalls++; throw new Error('Synthetic logger failure.'); },
    });
    const result = await ctx.runtime.start(baseInput());
    if (outcome === 'success') assert.equal(isComplete(result).answer, 'Ready.');
    else assert.equal(isFailed(result).error_code, 'request_failed');
    assert.equal(result.http_attempts, 1);
    assert.equal(ctx.calls.length, 1, 'logging failure must not cause a provider replay');
    assert.equal(diagnosticCalls, 2);
  });
}

for (const [label, plan, state] of [
  ['final answer', [completion('Unsafe echo: ' + syntheticCredential)], 'completed'],
  ['artifact content', [toolResponse(toolCall('call_echo', 'write_file', { path: 'echo.txt', content: syntheticCredential })), completion()], 'completed'],
  ['broker arguments', [toolResponse(toolCall('call_echo', 'codex_tool', { name: plugin.name,
    arguments: { key: { nested: [syntheticCredential] } } }))], 'waiting_for_tools'],
]) {
  test(`known credentials are removed before becoming visible or persisting: ${label}`, async t => {
    const ctx = fixture(t, plan);
    const result = await ctx.runtime.start(baseInput({ plugin_tools: [plugin] }));
    assert.ok(!JSON.stringify(result).includes(syntheticCredential));
    if (result.state === 'failed') {
      assert.equal(result.error_code, 'model_response_invalid', 'a failure must specifically reject the unsafe provider response');
      assert.equal(ctx.calls.length, 1);
      assert.equal(collectFiles(ctx.scratchRoot).length, 0);
    } else {
      assert.equal(result.state, state);
      assert.ok(JSON.stringify(result).includes('[REDACTED]'), 'the credential echo must be explicitly redacted');
      assert.equal(ctx.calls.length, plan.length);
    }
    for (const path of collectFiles(ctx.scratchRoot)) assert.ok(!readFileSync(path, 'utf8').includes(syntheticCredential));
  });
}

test('JSON-escaped tool arguments cannot bypass known-credential removal', async t => {
  const escaped = [...syntheticCredential].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const ctx = fixture(t, [toolResponse(toolCall('call_escaped', 'write_file',
    '{"path":"echo.txt","content":"' + escaped + '"}', true)), completion()]);
  const result = await ctx.runtime.start(baseInput());
  assert.ok(!JSON.stringify(result).includes(syntheticCredential));
  if (result.state === 'failed') {
    assert.equal(result.error_code, 'model_response_invalid');
    assert.equal(ctx.calls.length, 1);
    assert.equal(collectFiles(ctx.scratchRoot).length, 0);
  } else {
    isComplete(result);
    assert.ok(JSON.stringify(result).includes('[REDACTED]'));
    assert.equal(ctx.calls.length, 2);
  }
  for (const path of collectFiles(ctx.scratchRoot)) assert.ok(!readFileSync(path, 'utf8').includes(syntheticCredential));
});

test('known credentials in nested host results are removed before another model request', async t => {
  const ctx = fixture(t, [broker(), completion()]);
  const waiting = await ctx.runtime.start(baseInput({ plugin_tools: [plugin] }));
  const result = isComplete(await ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: waiting.requests[0].request_id, result: { nested: [{ value: syntheticCredential }] } }] }));
  assert.ok(!JSON.stringify(ctx.calls[1].body).includes(syntheticCredential));
  assert.ok(JSON.stringify(ctx.calls[1].body).includes('[REDACTED]'));
  assert.ok(!JSON.stringify(result).includes(syntheticCredential));
});

test('accumulated tool context stops before it can exceed the conversation bound', async t => {
  const ctx = fixture(t, index => toolResponse(toolCall('call_read_' + index, 'read_file', { path: 'large.txt' })));
  const failed = isFailed(await ctx.runtime.start(baseInput({ task: 'T'.repeat(120 * 1024),
    files: [{ path: 'large.txt', content: 'X'.repeat(60 * 1024) }], max_steps: 8 })));
  assert.equal(failed.error_code, 'context_too_large');
  assert.ok(ctx.calls.length >= 2, 'the test must exercise accumulated context after successful file reads');
  assert.ok(ctx.calls.length <= 3, 'the context bound must stop before another oversized provider request');
  for (const call of ctx.calls) assert.ok(Buffer.byteLength(JSON.stringify(call.body.messages)) <= 256 * 1024);
});

test('oversized broker results are rejected without consuming valid pending IDs', async t => {
  const ctx = fixture(t, [broker(), completion()]);
  const waiting = await ctx.runtime.start(baseInput({ plugin_tools: [plugin] }));
  await rejectedWithoutRequest(ctx, () => ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: waiting.requests[0].request_id, result: 'X'.repeat(64 * 1024 + 1) }] }));
  assert.equal((await ctx.runtime.status({ task_id: waiting.task_id })).state, 'waiting_for_tools');
  isComplete(await ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: waiting.requests[0].request_id, result: 'small valid result' }] }));
});

for (const [label, extra] of [
  ['unknown model', { model: 'automatic' }],
  ['empty task', { task: '' }],
  ['oversized task', { task: 'T'.repeat(128 * 1024 + 1) }],
  ['oversized file', { files: [{ path: 'large.txt', content: 'X'.repeat(64 * 1024 + 1) }] }],
  ['oversized file total', { files: [1, 2, 3].map(n => ({ path: n + '.txt', content: 'X'.repeat(50 * 1024) })) }],
  ['duplicate input files', { files: [{ path: 'same.txt', content: 'a' }, { path: 'same.txt', content: 'b' }] }],
  ['duplicate plugin names', { plugin_tools: [plugin, plugin] }],
  ['oversized plugin description', { plugin_tools: [{ ...plugin, description: 'X'.repeat(2049) }] }],
  ['too many plugins', { plugin_tools: Array.from({ length: 33 }, (_, index) => ({ ...plugin, name: 'tool_' + index })) }],
  ['zero step budget', { max_steps: 0 }],
  ['fractional tool budget', { max_tool_calls: 1.5 }],
  ['zero total timeout', { total_timeout_ms: 0 }],
]) {
  test(`invalid or oversized start input fails before credentials and network: ${label}`, async t => {
    const ctx = fixture(t, []);
    await rejectedWithoutRequest(ctx, () => ctx.runtime.start(baseInput(extra)));
    assert.equal(ctx.counters.credential, 0);
    assert.equal(collectFiles(ctx.scratchRoot).length, 0);
  });
}

test('unknown task inspection and cancellation never load credentials', async t => {
  const ctx = fixture(t, []);
  for (const method of ['status', 'resume', 'cancel']) {
    await assert.rejects(() => ctx.runtime[method]({ task_id: 'unknown-synthetic-task', results: [] }));
  }
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.counters.credential, 0);
});

test('terminal history does not permanently exhaust the bounded active-task capacity', async t => {
  const ctx = fixture(t, () => completion());
  const ids = new Set();
  for (let index = 0; index < 18; index++) {
    const result = isComplete(await ctx.runtime.start(baseInput({ task: 'Synthetic task ' + index })));
    assert.ok(!ids.has(result.task_id));
    ids.add(result.task_id);
  }
  assert.equal(ctx.calls.length, 18);
});

test('pending tasks still obey the active task capacity without a seventeenth provider request', async t => {
  const ctx = fixture(t, index => broker('call_' + index));
  for (let index = 0; index < 16; index++) {
    const waiting = await ctx.runtime.start(baseInput({ plugin_tools: [plugin] }));
    assert.equal(waiting.state, 'waiting_for_tools');
  }
  await rejectedWithoutRequest(ctx, () => ctx.runtime.start(baseInput({ plugin_tools: [plugin] })));
  assert.equal(ctx.calls.length, 16);
});

test('configured max minimum rejects an omitted 4096 budget before credential and scratch effects', async t => {
  const ctx = fixture(t, [], { configuration: outputBudgetConfiguration() });
  const failed = isFailed(await ctx.runtime.start(baseInput()));
  assert.equal(failed.error_code, 'output_budget_insufficient');
  assert.equal(failed.output_budget.requested_output_tokens, 4096);
  assert.equal(failed.output_budget.minimum_output_tokens, 16384);
  assert.equal(failed.last_response, null);
  assert.equal(failed.steps, 0);
  assert.equal(failed.http_attempts, 0);
  assert.equal(ctx.counters.credential, 0);
  assert.equal(ctx.calls.length, 0);
  assert.deepEqual(readdirSync(ctx.scratchRoot), []);
});

test('first explicit max budget and explicit none keep their requested values', async t => {
  for (const [effort, tokens] of [['max', 16384], ['none', 4096]]) {
    const ctx = fixture(t, [completion()], { configuration: outputBudgetConfiguration() });
    isComplete(await ctx.runtime.start(baseInput({ reasoning_effort: effort, max_output_tokens: tokens })));
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.calls[0].body.max_tokens, tokens);
    assert.equal(ctx.calls[0].body.reasoning_effort, effort === 'none' ? undefined : effort);
    assert.equal(ctx.calls[0].body.thinking.type, effort === 'none' ? 'disabled' : 'enabled');
    assert.ok(ctx.calls[0].body.messages[0].content.includes(String(tokens)));
  }
});

test('no configured policy retains max 4096 without silently increasing it', async t => {
  const ctx = fixture(t, [completion()], { configuration: outputBudgetConfiguration(false) });
  isComplete(await ctx.runtime.start(baseInput()));
  assert.equal(ctx.calls[0].body.max_tokens, 4096);
  assert.equal(ctx.calls[0].body.reasoning_effort, 'max');
});

test('truncation exposes reported exhaustion but never replays or executes an unfinished tool', async t => {
  const cases = [
    [4096, 4096, 'reasoning'], [4096, 1200, 'mixed'], [4000, 4000, 'unknown'],
    [4096, 4097, 'unknown'], [4096, '4096', 'unknown'], [undefined, undefined, 'unknown'],
  ];
  for (const [total, reasoning, expected] of cases) {
    const response = toolResponse(toolCall('synthetic_incomplete', 'write_file',
      { path: 'must-not-exist.txt', content: 'not committed' }));
    response.data.choices[0].finish_reason = 'length';
    response.data.usage = { completion_tokens: total, completion_tokens_details: { reasoning_tokens: reasoning } };
    const ctx = fixture(t, [response], { configuration: outputBudgetConfiguration(false) });
    const failed = isFailed(await ctx.runtime.start(baseInput()));
    assert.equal(failed.error_code, 'answer_truncated');
    assert.equal(failed.max_output_tokens, 4096);
    assert.equal(failed.last_response.step_index, 1);
    assert.equal(failed.last_response.finish_reason, 'length');
    assert.equal(failed.budget_exhaustion, expected);
    assert.equal(ctx.calls.length, 1);
    assert.equal(failed.tool_calls, 0);
    assert.deepEqual(failed.artifacts, []);
  }
});

test('production step and task diagnostics correlate budgets without exposing reasoning', async t => {
  const response = completion();
  response.data.choices[0].finish_reason = 'length';
  response.data.usage = { completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 4096 } };
  const ctx = fixture(t, [response], { configuration: outputBudgetConfiguration(false), recordDiagnostic });
  const failed = isFailed(await ctx.runtime.start(baseInput()));
  const entries = readFileSync(join(ctx.stateDir, 'diagnostics.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(entries.map(entry => entry.action), ['agent_step', 'agent_task']);
  const taskHash = 'sha256:' + createHash('sha256').update(failed.task_id).digest('hex').slice(0, 16);
  assert.equal(entries[0].task_id_hash, taskHash);
  assert.equal(entries[1].task_id_hash, taskHash);
  assert.equal(entries[0].step_index, 1);
  assert.equal(entries[0].max_output_tokens, 4096);
  assert.equal(entries[0].reasoning_effort, 'max');
  assert.deepEqual(entries[1].last_response, failed.last_response);
  assert.equal(entries[1].budget_exhaustion, 'reasoning');
  assert.doesNotMatch(JSON.stringify(entries), new RegExp(unsafeReasoning + '|' + failed.task_id));
});
