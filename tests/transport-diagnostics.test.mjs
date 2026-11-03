// These tests use only synthetic state, credentials and fetch responses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig, request, recordDiagnostic, safeTransportCode } from '../skills/deepseek-collaboration/scripts/deepseek-client.mjs';
import { createAgentRuntime } from '../skills/deepseek-collaboration/scripts/deepseek-agent-runtime.mjs';
import { StreamResponseError } from '../skills/deepseek-collaboration/scripts/deepseek-stream.mjs';

const privateMarker = 'SYNTHETIC-PRIVATE-TRANSPORT-CONTENT';
const credential = 'sk-SYNTHETIC-TRANSPORT-ONLY-DO-NOT-USE';
const config = { base_url: 'https://api.example.test/v1', allowed_origin: 'https://api.example.test',
  protocol: 'openai', model: 'deepseek-flash-test', models: { flash: 'deepseek-flash-test' }, credential_source: 'env' };
const body = { model: config.model, messages: [{ role: 'user', content: privateMarker }] };
const policy = { timeoutMs: 1000, totalTimeoutMs: 5000, maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 1 };
const tempRoot = realpathSync(tmpdir());
globalThis.fetch = async () => { throw new Error('Offline transport tests forbid network access.'); };

function fixture(t) {
  const directory = mkdtempSync(join(tempRoot, 'codex-deepseek-transport-test-'));
  t.after(() => {
    const actual = realpathSync(directory);
    const scoped = relative(tempRoot, actual);
    assert.ok(actual === resolve(directory) && scoped && !isAbsolute(scoped) && scoped !== '..'
      && !scoped.startsWith('..' + sep) && basename(actual).startsWith('codex-deepseek-transport-test-'));
    rmSync(actual, { recursive: true, force: true });
  });
  return directory;
}

function httpError(status = 503) {
  return { ok: false, status, headers: new Headers({ 'x-request-id': 'req-offline-safe' }),
    body: { cancel: async () => {}, getReader: () => { throw new Error('Error bodies must not be read.'); } } };
}

function success(data = { choices: [{ finish_reason: 'stop', message: { content: 'Ready.' } }] }) {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
}

function sse(events) {
  return new Response(events.map(event => 'data: ' + (typeof event === 'string' ? event : JSON.stringify(event)) + '\n\n').join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function sseCompletion(content = 'Ready.') {
  return sse([
    { model: config.model, choices: [{ index: 0, delta: { role: 'assistant', content,
      reasoning_content: privateMarker }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { completion_tokens: 16, completion_tokens_details: { reasoning_tokens: 8 } } },
    '[DONE]',
  ]);
}

test('transport configuration defaults to JSON and accepts only explicit json or sse', async t => {
  const directory = fixture(t);
  const path = join(directory, 'connection.json');
  for (const transportMode of [undefined, 'json', 'sse']) {
    writeFileSync(path, JSON.stringify({ ...config, ...(transportMode ? { transport_mode: transportMode } : {}) }));
    assert.equal((await loadConfig(directory)).transport_mode, transportMode ?? 'json');
  }
  for (const transportMode of ['automatic', true, {}, privateMarker]) {
    writeFileSync(path, JSON.stringify({ ...config, transport_mode: transportMode }));
    await assert.rejects(loadConfig(directory), error => {
      assert.equal(error.code, 'configuration_invalid');
      assert.ok(!error.message.includes(privateMarker));
      return true;
    });
  }
});

test('only an explicit streamed body selects SSE; JSON and model-list GET remain JSON', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls.push(options);
    return options.headers.Accept === 'text/event-stream' ? sseCompletion() : success();
  });
  const streamed = await request(config, '/chat/completions', credential,
    { ...body, stream: true, stream_options: { include_usage: true } }, policy);
  assert.equal(streamed.data.choices[0].message.content, 'Ready.');
  assert.equal(streamed.data.usage.completion_tokens, 16);
  assert.equal(streamed.metadata.transport_mode, 'sse');
  assert.equal(calls[0].headers.Accept, 'text/event-stream');
  const json = await request({ ...config, transport_mode: 'sse' }, '/chat/completions', credential, body, policy);
  assert.equal(json.metadata.transport_mode, 'json');
  const models = await request({ ...config, transport_mode: 'sse' }, '/models', credential, undefined, policy);
  assert.equal(models.metadata.transport_mode, 'json');
  assert.equal(calls[2].method, 'GET');
  assert.equal(calls[2].headers.Accept, 'application/json');
  assert.equal(calls.length, 3);
});

test('an incomplete SSE response fails once without JSON fallback or request replay', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return sse([{ choices: [{ index: 0, delta: { content: privateMarker }, finish_reason: 'stop' }] }]);
  });
  await assert.rejects(request(config, '/chat/completions', credential, { ...body, stream: true }, policy), error => {
    assert.equal(error.code, 'response_invalid');
    assert.equal(error.metadata.attempts, 1);
    assert.equal(error.metadata.error_category, 'response');
    assert.equal(error.metadata.response_reason, 'missing_done');
    assert.equal(error.metadata.transport_mode, 'sse');
    assert.ok(!error.message.includes(privateMarker));
    return true;
  });
  assert.equal(calls, 1);
});

for (const [code, reason] of [['response_invalid', 'missing_done'], ['response_too_large', 'wire_limit']]) {
  test(`SSE protocol diagnostics retain the controlled ${reason} reason without changing its error code`, async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) {
        controller.error(new StreamResponseError(code, reason));
      } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    await assert.rejects(request(config, '/chat/completions', credential, { ...body, stream: true }, policy), error => {
      assert.equal(error.code, code);
      assert.equal(error.metadata.error_category, 'response');
      assert.equal(error.metadata.response_reason, reason);
      assert.equal(error.metadata.attempts, 1);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test('unknown or hostile SSE error reasons are discarded before network metadata and logging', async t => {
  const directory = fixture(t);
  let calls = 0;
  const hostile = { toString() { throw new Error(privateMarker); } };
  for (const reason of [privateMarker + credential, hostile]) {
    let failure;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      const error = new StreamResponseError('response_invalid', 'missing_done');
      error.reason = reason;
      return new Response(new ReadableStream({ start(controller) { controller.error(error); } }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    await assert.rejects(request(config, '/chat/completions', credential, { ...body, stream: true }, policy), error => {
      assert.equal(error.code, 'response_invalid');
      assert.equal(error.metadata.error_category, 'response');
      assert.equal(error.metadata.response_reason, undefined);
      failure = error;
      return true;
    });
    await recordDiagnostic(directory, 'agent_step', 'flash', {
      ...failure.metadata, ok: false, error_code: failure.code, response_reason: reason,
    });
  }
  assert.equal(calls, 2);
  const source = readFileSync(join(directory, 'diagnostics.jsonl'), 'utf8');
  for (const entry of source.trim().split('\n').map(JSON.parse)) assert.equal(entry.response_reason, null);
  assert.ok(!source.includes(privateMarker) && !source.includes(credential));
});

test('runtime failed network and both diagnostics preserve only a known response reason', async t => {
  const directory = fixture(t);
  const entries = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return sse([{ choices: [{ index: 0, delta: { content: privateMarker }, finish_reason: 'stop' }] }]);
  });
  const runtime = createAgentRuntime({ stateDir: directory, scratchRoot: join(directory, 'scratch'),
    loadConfig: async () => ({ ...config, transport_mode: 'sse' }), loadCredential: async () => credential, request,
    recordDiagnostic: async (stateDir, action, model, result) => {
      entries.push(structuredClone({ action, result }));
      return await recordDiagnostic(stateDir, action, model, result);
    } });
  t.after(() => runtime.dispose());
  const failed = await runtime.start({ task: privateMarker, model: 'flash' });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error_code, 'response_invalid');
  assert.equal(failed.network.error_category, 'response');
  assert.equal(failed.network.response_reason, 'missing_done');
  assert.equal((await runtime.status({ task_id: failed.task_id })).network.response_reason, 'missing_done');
  assert.equal(calls, 1);
  assert.equal(entries.find(entry => entry.action === 'agent_step').result.response_reason, 'missing_done');
  assert.equal(entries.find(entry => entry.action === 'agent_task').result.response_reason, 'missing_done');
  const source = readFileSync(join(directory, 'diagnostics.jsonl'), 'utf8');
  for (const entry of source.trim().split('\n').map(JSON.parse)) assert.equal(entry.response_reason, 'missing_done');
  assert.ok(!source.includes(privateMarker) && !source.includes(credential) && !source.includes(failed.task_id));
});

test('runtime drops an untrusted response reason injected with a safe provider error', async t => {
  const directory = fixture(t);
  const entries = [];
  const runtime = createAgentRuntime({ stateDir: directory, scratchRoot: join(directory, 'scratch'),
    loadConfig: async () => config, loadCredential: async () => credential,
    request: async () => { throw Object.assign(new Error(privateMarker), { code: 'response_invalid', metadata: {
      attempts: 1, error_category: 'response', response_reason: privateMarker + credential,
    } }); },
    recordDiagnostic: async (_stateDir, action, _model, result) => { entries.push(structuredClone({ action, result })); } });
  t.after(() => runtime.dispose());
  const failed = await runtime.start({ task: privateMarker, model: 'flash' });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error_code, 'response_invalid');
  assert.equal(failed.network.response_reason, undefined);
  assert.ok(entries.every(entry => entry.result.response_reason === undefined));
  assert.ok(!JSON.stringify(entries).includes(privateMarker) && !JSON.stringify(entries).includes(credential));
});

test('an SSE reader transport failure keeps its safe short code and is never replayed', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) {
      controller.error(new Error(privateMarker + credential, { cause: { code: 'UND_ERR_SOCKET' } }));
    } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  await assert.rejects(request(config, '/chat/completions', credential, { ...body, stream: true }, policy), error => {
    assert.equal(error.code, 'request_failed');
    assert.equal(error.metadata.error_category, 'body');
    assert.equal(error.metadata.transport_code, 'UND_ERR_SOCKET');
    assert.ok(!JSON.stringify([error.message, error.metadata]).includes(privateMarker));
    return true;
  });
  assert.equal(calls, 1);
});

test('an SSE reader uses the existing hard request deadline without replay', { timeout: 10_000 }, async t => {
  let calls = 0;
  let streamController;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) { streamController = controller; } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  t.after(() => streamController?.error(new Error('Synthetic test cleanup.')));
  await assert.rejects(request(config, '/chat/completions', credential, { ...body, stream: true },
    { ...policy, timeoutMs: 30 }), error => {
    assert.equal(error.code, 'request_timeout');
    assert.equal(error.metadata.attempts, 1);
    assert.equal(error.metadata.http_status, 200);
    return true;
  });
  assert.equal(calls, 1);
});

test('runtime SSE tool writes and reasoning continuations preserve artifacts and safe diagnostics', async t => {
  const directory = fixture(t);
  const calls = [];
  const entries = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length > 1) return sseCompletion();
    return sse([
      { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: privateMarker,
        tool_calls: [{ index: 0, id: 'call_write', type: 'function', function: {
          name: 'write_file', arguments: '{"path":"draft.txt",',
        } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: {
        arguments: '"content":"COMMITTED-SSE-ARTIFACT"}',
      } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]',
    ]);
  });
  const runtime = createAgentRuntime({ stateDir: directory, scratchRoot: join(directory, 'scratch'),
    loadConfig: async () => ({ ...config, transport_mode: 'sse', default_reasoning_effort: 'max' }),
    loadCredential: async () => credential, request,
    recordDiagnostic: async (_stateDir, action, _model, result) => { entries.push(structuredClone({ action, result })); } });
  t.after(() => runtime.dispose());
  const result = await runtime.start({ task: privateMarker, model: 'flash' });
  assert.equal(result.state, 'completed');
  assert.equal(result.artifacts[0]?.content, 'COMMITTED-SSE-ARTIFACT');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.stream, true);
    assert.deepEqual(call.stream_options, { include_usage: true });
    assert.equal(call.reasoning_effort, 'max');
  }
  assert.ok(calls[1].messages.some(message => message.role === 'assistant' && message.reasoning_content === privateMarker));
  assert.equal(entries.filter(entry => entry.action === 'agent_task').length, 1);
  assert.ok(entries.every(entry => entry.result.transport_mode === 'sse'));
  assert.equal(entries.filter(entry => entry.action === 'agent_step').at(-1).result.reasoning_tokens, 8);
  assert.ok(!JSON.stringify(entries).includes(privateMarker));
  assert.ok(!JSON.stringify(result).includes(privateMarker));
});

test('a pre-aborted request makes no HTTP attempt and suppresses the abort reason', { timeout: 10_000 }, async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return success(); });
  const controller = new AbortController();
  controller.abort(new Error(privateMarker + credential));
  await assert.rejects(request(config, '/chat/completions', credential, body, policy, { signal: controller.signal }), error => {
    assert.equal(error.code, 'request_cancelled');
    assert.equal(error.metadata.attempts, 0);
    assert.equal(error.metadata.error_category, 'cancelled');
    assert.deepEqual(error.metadata.attempt_history, []);
    assert.ok(!JSON.stringify([error.message, error.metadata]).includes(privateMarker));
    return true;
  });
  assert.equal(calls, 0);
});

test('cancellation after dispatch prevents a late HTTP 503 from starting another POST', { timeout: 10_000 }, async t => {
  let release;
  let entered;
  let calls = 0;
  let fetchSignal;
  const begun = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    fetchSignal = options.signal;
    entered();
    return await delayed;
  });
  const controller = new AbortController();
  const running = request(config, '/chat/completions', credential, body, policy, { signal: controller.signal });
  await begun;
  controller.abort(new Error(privateMarker));
  assert.equal(fetchSignal.aborted, true, 'external cancellation stops local waiting without claiming to retract server work');
  await assert.rejects(running, error => {
    assert.equal(error.code, 'request_cancelled');
    assert.equal(error.metadata.attempts, 1);
    assert.equal(error.metadata.http_status, null, 'headers that arrive after cancellation do not become a committed response');
    assert.equal(error.metadata.error_category, 'cancelled');
    return true;
  });
  release(httpError());
  assert.equal(calls, 1);
});

test('retry backoff is interruptible and removes its cancellation listener', { timeout: 10_000 }, async t => {
  const controller = new AbortController();
  const addListener = controller.signal.addEventListener.bind(controller.signal);
  const removeListener = controller.signal.removeEventListener.bind(controller.signal);
  let calls = 0;
  let added = 0;
  let removed = 0;
  t.mock.method(controller.signal, 'addEventListener', (name, listener, options) => {
    added++;
    addListener(name, listener, options);
    if (added === 2) queueMicrotask(() => controller.abort(new Error(privateMarker)));
  });
  t.mock.method(controller.signal, 'removeEventListener', (name, listener) => {
    removed++;
    removeListener(name, listener);
  });
  t.mock.method(globalThis, 'fetch', async () => { calls++; return httpError(); });
  const startedAt = performance.now();
  await assert.rejects(request(config, '/chat/completions', credential, body,
    { ...policy, retryBaseMs: 4000, retryMaxMs: 4000 }, { signal: controller.signal }), error => {
    assert.equal(error.code, 'request_cancelled');
    assert.equal(error.metadata.attempts, 1);
    assert.equal(error.metadata.error_category, 'cancelled');
    assert.equal(error.metadata.attempt_history[0].status, 503);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(added, 2, 'the first listener covers the active request; the second covers retry backoff');
  assert.equal(removed, 2);
  assert.ok(performance.now() - startedAt < 1500, 'cancellation must not wait out the >=2000ms backoff');
});

test('ordinary explicit HTTP retries retain the existing three-attempt cap', { timeout: 10_000 }, async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls < 3 ? httpError() : success());
  const result = await request(config, '/chat/completions', credential, body, policy);
  assert.equal(calls, 3);
  assert.equal(result.metadata.attempts, 3);
  assert.equal(result.metadata.error_category, null);
});

test('runtime cancellation reaches the real client without another retry or terminal log', { timeout: 10_000 }, async t => {
  const directory = fixture(t);
  let entered;
  let release;
  let calls = 0;
  const begun = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const entries = [];
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return success({ choices: [{ finish_reason: 'tool_calls', message: {
      content: null, tool_calls: [{ id: 'call_broker', type: 'function', function: {
        name: 'codex_tool', arguments: JSON.stringify({ name: 'lookup_reference', arguments: {} }),
      } }],
    } }] });
    entered();
    return await delayed;
  });
  const runtime = createAgentRuntime({ stateDir: directory, scratchRoot: join(directory, 'scratch'),
    loadConfig: async () => config, loadCredential: async () => credential, request,
    recordDiagnostic: async (_stateDir, action, _model, result) => { entries.push(structuredClone({ action, result })); } });
  t.after(() => runtime.dispose());
  const waiting = await runtime.start({ task: privateMarker, model: 'flash',
    plugin_tools: [{ name: 'lookup_reference', description: 'Synthetic lookup.' }] });
  assert.equal(waiting.state, 'waiting_for_tools');
  const running = runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: waiting.requests[0].request_id, result: 'continue' }] });
  await begun;
  assert.equal((await runtime.cancel({ task_id: waiting.task_id })).state, 'cancelling');
  release(httpError());
  const cancelled = await running;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.http_attempts, 2);
  assert.equal(calls, 2);
  assert.equal(entries.filter(entry => entry.action === 'agent_task').length, 1);
  const failedStep = entries.filter(entry => entry.action === 'agent_step').at(-1).result;
  assert.equal(failedStep.error_code, 'request_cancelled');
  assert.equal(failedStep.error_category, 'cancelled');
  assert.ok(!JSON.stringify(entries).includes(privateMarker));
  assert.ok(!JSON.stringify(entries).includes(credential));
});

test('transport codes traverse bounded cause and AggregateError trees without inspecting messages or getters', () => {
  const socket = Object.assign(new Error(privateMarker), { code: 'UND_ERR_SOCKET' });
  assert.equal(safeTransportCode(new Error(privateMarker, {
    cause: new AggregateError([new Error(privateMarker), socket], privateMarker),
  })), 'UND_ERR_SOCKET');
  assert.equal(safeTransportCode({ cause: { cause: { code: 'EPIPE' } } }), 'EPIPE');
  const hostile = { cause: null, errors: [] };
  hostile.cause = hostile;
  hostile.errors.push(hostile);
  Object.defineProperty(hostile, 'code', { get() { throw new Error(privateMarker); } });
  assert.equal(safeTransportCode(hostile), null);
  assert.equal(safeTransportCode({ errors: [null, null, null, null, socket] }), null, 'error fanout is bounded');
  assert.equal(safeTransportCode({ code: privateMarker }), null);
});

test('production task diagnostics preserve only terminal enums, numeric budgets and the explicit task hash', async t => {
  const directory = fixture(t);
  const taskHash = 'sha256:0123456789abcdef';
  assert.equal(await recordDiagnostic(directory, 'agent_task', 'flash', {
    ok: false, state: 'failed', task_id_hash: taskHash, reasoning_effort: 'max',
    total_timeout_ms: 1800000, max_output_tokens: 4096, max_steps: 48, max_tool_calls: 96,
    max_http_attempts: 144, steps: 48, tool_calls: 96, http_attempts: 144, artifact_count: 1,
    last_response:{step_index:48,finish_reason:'length',completion_tokens:4096,reasoning_tokens:4000},
    elapsed_ms: 32, error_code: 'answer_truncated', task_id: privateMarker,
    prompt: privateMarker, content: privateMarker, arguments: { key: credential }, path: directory,
    reasoning_content: privateMarker,
  }), true);
  assert.equal(await recordDiagnostic(directory, 'agent_task', privateMarker, {
    ok: false, state: privateMarker, task_id_hash: privateMarker, reasoning_effort: privateMarker,
    total_timeout_ms: -1, max_output_tokens: Infinity, max_steps: 50, steps: -1,
    error_code: privateMarker, artifact_count: privateMarker,
  }), true);
  const source = readFileSync(join(directory, 'diagnostics.jsonl'), 'utf8');
  const [valid, invalid] = source.trim().split('\n').map(JSON.parse);
  assert.equal(valid.task_id_hash, taskHash);
  assert.equal(valid.state, 'failed');
  assert.equal(valid.max_output_tokens, 4096);
  assert.equal(valid.artifact_count, 1);
  assert.equal(valid.error_code, 'answer_truncated');
  assert.equal(valid.total_timeout_ms,1800000);
  assert.equal(valid.max_steps,48);assert.equal(valid.steps,48);
  assert.equal(valid.max_tool_calls,96);assert.equal(valid.tool_calls,96);
  assert.equal(valid.max_http_attempts,144);assert.equal(valid.http_attempts,144);
  assert.equal(valid.last_response.step_index,48);
  assert.equal(valid.task_id, undefined);
  for (const field of ['model', 'state', 'task_id_hash', 'reasoning_effort', 'total_timeout_ms',
    'max_output_tokens', 'max_steps', 'error_code']) assert.equal(invalid[field], null);
  assert.equal(invalid.steps, 0);
  assert.ok(!source.includes(privateMarker) && !source.includes(credential) && !source.includes(directory));
});

test('production step diagnostics whitelist finish reasons and token counts while hashing request IDs', async t => {
  const directory = fixture(t);
  const rawId = 'req-offline-output-1';
  await recordDiagnostic(directory, 'agent_step', 'flash', { ok: true, attempts: 1, http_status: 200,
    finish_reason: 'max_tokens', completion_tokens: 4096, reasoning_tokens: 3999,
    request_id: rawId, attempt_history: [{ attempt: 1, status: 200, category: 'ok',
      request_id: rawId, message: privateMarker }], body: privateMarker, error_code: privateMarker,
    transport_code: privateMarker, reasoning_content: privateMarker });
  await recordDiagnostic(directory, 'ask', 'flash', { ok: false, finish_reason: privateMarker,
    usage: { completion_tokens: 1.5, completion_tokens_details: { reasoning_tokens: Infinity },
      prompt: privateMarker, credential } });
  const source = readFileSync(join(directory, 'diagnostics.jsonl'), 'utf8');
  const [valid, invalid] = source.trim().split('\n').map(JSON.parse);
  assert.equal(valid.finish_reason, 'max_tokens');
  assert.equal(valid.completion_tokens, 4096);
  assert.equal(valid.reasoning_tokens, 3999);
  assert.equal(valid.request_id, 'sha256:' + createHash('sha256').update(rawId).digest('hex').slice(0, 16));
  assert.equal(valid.attempt_history[0].request_id, valid.request_id);
  assert.equal(valid.error_code, null);
  assert.equal(valid.transport_code, null);
  assert.equal(invalid.finish_reason, null);
  assert.equal(invalid.completion_tokens, null);
  assert.equal(invalid.reasoning_tokens, null);
  assert.ok(!source.includes(privateMarker) && !source.includes(credential) && !source.includes(rawId));
});
