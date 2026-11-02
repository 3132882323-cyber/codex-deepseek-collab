// All event streams, credentials, and tool calls in this suite are synthetic.
import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { readChatCompletionStream, StreamResponseError, safeStreamResponseReason } from '../skills/deepseek-collaboration/scripts/deepseek-stream.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 10_000 }, fn);
const encoder = new TextEncoder();
globalThis.fetch = async () => { throw new Error('Offline stream tests forbid networking.'); };

function frame(delta = {}, finish = null, extra = {}) {
  return { id: 'synthetic-stream-id', model: 'deepseek-synthetic-flash', created: 1,
    object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra };
}
function event(data, ending = '\n') {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}${ending}${ending}`;
}
function stream(...frames) { return frames.map(value => event(value)).join('') + event('[DONE]'); }
function responseFor(text, options = {}) {
  const data = typeof text === 'string' ? encoder.encode(text) : text;
  const size = options.chunkSize ?? (data.length || 1);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset < data.length) {
        controller.enqueue(data.slice(offset, offset + size));
        offset += size;
      } else if (options.close !== false) controller.close();
    },
    cancel() { return options.cancel?.(); },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8', ...options.headers } });
}
async function invalid(text, options, reason) {
  await assert.rejects(() => readChatCompletionStream(responseFor(text, options)), error => {
    assert.ok(error instanceof StreamResponseError);
    assert.equal(error.code, 'response_invalid');
    if (reason !== undefined) assert.equal(error.reason, reason);
    assert.doesNotMatch(error.message, /PRIVATE-SENTINEL/);
    return true;
  });
}
async function promptly(operation) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Cleanup blocked a completed parser result.')), 500);
    })]);
  } finally { clearTimeout(timer); }
}

test('UTF-8, CRLF and reasoning survive arbitrary network chunk boundaries', async () => {
  const usage = { completion_tokens: 14, completion_tokens_details: { reasoning_tokens: 8 } };
  const text = ': keep-alive\r\n\r\n'
    + event(frame({ role: 'assistant', content: '', reasoning_content: '内部' }), '\r\n')
    + event(frame({ reasoning_content: '思考🙂' }), '\r\n')
    + event(frame({ content: '你好🙂' }), '\r\n')
    + event(frame({ content: '完成' }, 'stop', { usage }), '\r\n') + event('[DONE]', '\r\n');
  for (const chunkSize of [1, 2, 7, encoder.encode(text).length]) {
    const result = await readChatCompletionStream(responseFor(text, { chunkSize }));
    assert.equal(result.choices[0].message.content, '你好🙂完成');
    assert.equal(result.choices[0].message.reasoning_content, '内部思考🙂');
    assert.equal(result.choices[0].finish_reason, 'stop');
    assert.deepEqual(result.usage, usage);
    assert.equal(result.model, 'deepseek-synthetic-flash');
    assert.equal(result.object, 'chat.completion');
  }
});

test('mixed SSE line endings, comments and ordinary control fields preserve event data', async () => {
  const text = '\ufeff: keep-alive\r\rid: synthetic-event\nretry: 1000\nevent: message\n'
    + 'ignored-field: ignored\n'
    + 'data: {"choices": [\n: a comment inside an event\n'
    + 'data: {"index":0,"delta":{"role":"assistant","content":"multi-line"},"finish_reason":"stop"}\n'
    + 'data: ]}\r\n\r\n' + event('[DONE]', '\r');
  const result = await readChatCompletionStream(responseFor(text, { chunkSize: 3 }));
  assert.equal(result.choices[0].message.content, 'multi-line');
});

test('a complete DONE token at EOF is accepted without a final blank line', async () => {
  const text = event(frame({ content: 'ready' }, 'stop')) + 'data: [DONE]';
  assert.equal((await readChatCompletionStream(responseFor(text))).choices[0].message.content, 'ready');
});

test('DONE returns without waiting for EOF or a stalled reader cancellation', async () => {
  let cancelled = 0;
  const result = await promptly(readChatCompletionStream(responseFor(stream(frame({ content: 'ready' }, 'stop')), {
    close: false, cancel: () => { cancelled++; return new Promise(() => {}); },
  })));
  assert.equal(result.choices[0].message.content, 'ready');
  assert.equal(cancelled, 1);
});

test('native final-frame usage and separate usage-only frames are both supported', async () => {
  const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
  for (const frames of [
    [frame({ content: 'yes' }, 'stop', { usage })],
    [frame({ content: 'yes' }, 'stop'), { choices: [], usage }],
    [frame({ content: 'yes' }, 'stop', { usage }), { choices: [], usage: { total_tokens: 8, completion_tokens: 3, prompt_tokens: 5 } }],
  ]) {
    const result = await readChatCompletionStream(responseFor(stream(...frames)));
    assert.deepEqual(result.usage, usage);
  }
});

test('interleaved tool calls merge ID, function name and argument fragments by index', async () => {
  const frames = [
    frame({ role: 'assistant', reasoning_content: 'internal', tool_calls: [{ index: 1, id: 'call_', type: 'function',
      function: { name: 'read_', arguments: '{"path":"' } }] }),
    frame({ tool_calls: [{ index: 0, id: 'call_', type: 'function', function: { name: 'write_', arguments: '{' } }] }),
    frame({ tool_calls: [
      { index: 1, id: 'b', function: { name: 'file', arguments: 'input.txt"}' } },
      { index: 0, id: 'a', function: { name: 'file', arguments: '"path":"out.txt","content":"x"}' } },
    ] }),
    frame({}, 'tool_calls'),
  ];
  const result = await readChatCompletionStream(responseFor(stream(...frames), { chunkSize: 5 }));
  assert.deepEqual(result.choices[0].message.tool_calls, [
    { id: 'call_a', type: 'function', function: { name: 'write_file', arguments: '{"path":"out.txt","content":"x"}' } },
    { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"input.txt"}' } },
  ]);
  assert.equal(result.choices[0].message.content, null);
  assert.equal(result.choices[0].message.reasoning_content, 'internal');
});

const call = index => ({ index, id: `call_${index}`, type: 'function', function: { name: 'list_files', arguments: '{}' } });

test('exactly 32 tool calls are allowed and their ordering remains stable', async () => {
  const result = await readChatCompletionStream(responseFor(stream(
    frame({ tool_calls: Array.from({ length: 32 }, (_, i) => call(31 - i)) }, 'tool_calls'))));
  assert.equal(result.choices[0].message.tool_calls.length, 32);
  assert.equal(result.choices[0].message.tool_calls[31].id, 'call_31');
});

test('a gateway stop finish still preserves its complete tool batch for the runtime', async () => {
  const result = await readChatCompletionStream(responseFor(stream(frame({ tool_calls: [call(0)] }, 'stop'))));
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'list_files');
});

for (const reason of ['length', 'max_tokens', 'max_output_tokens', 'content_filter', 'aborted', 'insufficient_system_resource']) {
  test(`the explicit terminal reason is preserved for the runtime: ${reason}`, async () => {
    const result = await readChatCompletionStream(responseFor(stream(frame({ content: 'partial' }, reason))));
    assert.equal(result.choices[0].finish_reason, reason);
  });
}

test('an incomplete length-limited tool call remains truncated rather than becoming a completion', async () => {
  const result = await readChatCompletionStream(responseFor(stream(frame({ tool_calls: [{ index: 1,
    function: { arguments: '{"unfinished":' } }] }, 'length'))));
  assert.equal(result.choices[0].finish_reason, 'length');
  assert.equal(result.choices[0].message.tool_calls[0].function.arguments, '{"unfinished":');
});

test('wire-byte limits count multibyte text and keep-alive traffic, including exact boundaries', async () => {
  const text = ': keep-alive\n\n' + stream(frame({ content: '你好🙂' }, 'stop'));
  const size = encoder.encode(text).length;
  assert.equal((await readChatCompletionStream(responseFor(text, { chunkSize: 1 }), size)).choices[0].message.content, '你好🙂');
  await assert.rejects(() => readChatCompletionStream(responseFor(text, { chunkSize: 3 }), size - 1),
    { code: 'response_too_large', reason: 'wire_limit' });
});

test('oversized Content-Length rejects before reading and cleans up without waiting', async () => {
  let read = 0;
  let cancelled = 0;
  const response = { headers: new Headers({ 'content-type': 'text/event-stream', 'content-length': '1000' }),
    body: { getReader() { read++; throw new Error('Should not read.'); }, cancel() { cancelled++; return new Promise(() => {}); } } };
  await assert.rejects(() => promptly(readChatCompletionStream(response, 20)),
    { code: 'response_too_large', reason: 'content_length_limit' });
  assert.equal(read, 0);
  assert.equal(cancelled, 1);
});

test('a long event split into tiny chunks is reconstructed exactly', async () => {
  const content = 'x'.repeat(20_000);
  const result = await readChatCompletionStream(responseFor(stream(frame({ content }, 'stop')), { chunkSize: 1 }));
  assert.equal(result.choices[0].message.content, content);
});

for (const [label, frames] of [
  ['missing DONE', event(frame({ content: 'complete-looking' }, 'stop'))],
  ['missing final finish', stream(frame({ content: 'partial' }))],
  ['DONE before any choice', event('[DONE]')],
  ['only keep-alive traffic', ': keep-alive\n\n\n'],
  ['invalid JSON', 'data: {"PRIVATE-SENTINEL":\n\n'],
  ['an explicit JSON error', event({ error: { message: 'PRIVATE-SENTINEL' } })],
  ['an explicit SSE error', 'event: error\ndata: PRIVATE-SENTINEL\n\n'],
  ['a late error after content', event(frame({ content: 'partial' })) + event({ error: 'PRIVATE-SENTINEL' })],
  ['unknown SSE event', 'event: unexpected\n' + event(frame({ content: 'x' }, 'stop')) + event('[DONE]')],
  ['empty data event', 'data:\n\n'],
  ['non-object JSON', event([])],
  ['delta after finish', stream(frame({ content: 'a' }, 'stop'), frame({ content: 'b' }))],
  ['contradictory finish', stream(frame({}, 'stop'), frame({}, 'length'))],
  ['duplicate finish', stream(frame({}, 'stop'), frame({}, 'stop'))],
  ['changed model', stream(frame({ content: 'a' }), frame({}, 'stop', { model: 'different' }))],
  ['changed completion ID', stream(frame({ content: 'a' }), frame({}, 'stop', { id: 'different' }))],
  ['changed created timestamp', stream(frame({ content: 'a' }), frame({}, 'stop', { created: 2 }))],
  ['wrong object shape', stream(frame({}, 'stop', { object: 'chat.completion' }))],
  ['usage contradiction', stream(frame({}, 'stop', { usage: { completion_tokens: 1 } }), { choices: [], usage: { completion_tokens: 2 } })],
  ['usage wrong shape', stream(frame({}, 'stop', { usage: 'PRIVATE-SENTINEL' }))],
  ['usage-only without usage', event({ choices: [], usage: null })],
  ['usage-only without a choice', stream({ choices: [], usage: { completion_tokens: 1 } })],
  ['extra data after DONE in received bytes', stream(frame({ content: 'a' }, 'stop')) + event(frame({ content: 'b' }))],
  ['duplicate DONE in received bytes', stream(frame({ content: 'a' }, 'stop')) + event('[DONE]')],
  ['unfinished trailing event after DONE', stream(frame({ content: 'a' }, 'stop')) + 'data: {'],
]) {
  test(`incomplete or contradictory streams fail without returning partial results: ${label}`, async () => {
    await invalid(frames);
  });
}

for (const [label, delta, choiceOverride] of [
  ['non-assistant role', { role: 'user' }],
  ['non-text content', { content: ['unsafe'] }],
  ['non-text reasoning', { reasoning_content: 42 }],
  ['legacy function call', { function_call: { name: 'legacy' } }],
  ['non-array tool calls', { tool_calls: {} }],
  ['non-object tool call', { tool_calls: [null] }],
  ['negative tool index', { tool_calls: [call(-1)] }],
  ['fractional tool index', { tool_calls: [call(0.5)] }],
  ['tool index past limit', { tool_calls: [call(32)] }],
  ['too many tool calls', { tool_calls: Array.from({ length: 33 }, (_, i) => call(i)) }],
  ['duplicate index in a delta', { tool_calls: [call(0), call(0)] }],
  ['unsupported tool type', { tool_calls: [{ ...call(0), type: 'custom' }] }],
  ['non-text arguments', { tool_calls: [{ ...call(0), function: { name: 'list_files', arguments: {} } }] }],
  ['missing tool ID', { tool_calls: [{ index: 0, type: 'function', function: { name: 'list_files', arguments: '{}' } }] }],
  ['missing function name', { tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { arguments: '{}' } }] }],
  ['missing function arguments', { tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: 'list_files' } }] }],
  ['missing tool type', { tool_calls: [{ index: 0, id: 'call_0', function: { name: 'list_files', arguments: '{}' } }] }],
  ['non-contiguous tool indexes', { tool_calls: [call(1)] }],
  ['duplicate complete tool IDs', { tool_calls: [call(0), { ...call(1), id: 'call_0' }] }],
  ['wrong choice index', {}, { index: 1 }],
  ['missing choice index', {}, { index: undefined }],
  ['missing delta', {}, { delta: undefined }],
  ['unknown finish reason', {}, { finish_reason: 'PRIVATE-SENTINEL' }],
]) {
  test(`invalid choice or tool structures fail: ${label}`, async () => {
    const value = frame(delta, 'stop');
    Object.assign(value.choices[0], choiceOverride);
    await invalid(stream(value));
  });
}

test('multiple choices cannot silently drop an unexpected choice', async () => {
  const value = frame({ content: 'first' }, 'stop');
  value.choices.push({ index: 1, delta: { content: 'second' }, finish_reason: 'stop' });
  await invalid(stream(value));
});

test('a tool_calls finish requires at least one complete tool', async () => {
  await invalid(stream(frame({}, 'tool_calls')));
});

test('trailing comments are allowed after the protocol terminator', async () => {
  const result = await readChatCompletionStream(responseFor(stream(frame({ content: 'a' }, 'stop')) + ': keep-alive\n\n: last comment'));
  assert.equal(result.choices[0].message.content, 'a');
});

test('invalid UTF-8 and a cut-off code point fail even across chunks', async () => {
  await invalid(Uint8Array.from([100, 97, 116, 97, 58, 32, 0xff, 10, 10]), { chunkSize: 1 });
  const prefix = encoder.encode(event(frame({ content: 'partial' })));
  await invalid(new Uint8Array([...prefix, 0xe4, 0xbd]), { chunkSize: 1 });
  const complete = encoder.encode(stream(frame({ content: 'ready' }, 'stop')));
  await invalid(new Uint8Array([...complete, 0xe4]));
});

test('native body interruption stays native and does not return a partial completion', async () => {
  const original = Object.assign(new Error('PRIVATE-SENTINEL native failure'), { code: 'ECONNRESET' });
  let reads = 0;
  let cancelled = 0;
  let released = 0;
  const response = { headers: new Headers({ 'content-type': 'text/event-stream' }), body: {
    getReader: () => ({
      read: async () => { if (reads++ === 0) return { done: false, value: encoder.encode(event(frame({ content: 'partial' }))) }; throw original; },
      cancel: () => { cancelled++; throw new Error('PRIVATE-SENTINEL cleanup failure'); },
      releaseLock: () => { released++; },
    }),
  } };
  await assert.rejects(() => readChatCompletionStream(response), error => error === original);
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
});

test('a semantic failure is not blocked or replaced by cancellation failure', async () => {
  const response = responseFor('data: PRIVATE-SENTINEL\n\n', {
    close: false, cancel: () => new Promise(() => {}),
  });
  await assert.rejects(() => promptly(readChatCompletionStream(response)), error => {
    assert.ok(error instanceof StreamResponseError);
    assert.equal(error.code, 'response_invalid');
    assert.doesNotMatch(error.message, /PRIVATE-SENTINEL/);
    return true;
  });
});

test('invalid reader, MIME and byte-budget inputs are refused', async () => {
  for (const maximum of [0, -1, 1.2, 16 * 1024 * 1024 + 1, Infinity, NaN]) {
    await assert.rejects(() => readChatCompletionStream(responseFor(''), maximum), { code: 'response_invalid' });
  }
  for (const response of [null, new Response(null), responseFor('', { headers: { 'content-type': 'application/json' } }),
    { headers: new Headers({ 'content-type': 'text/event-stream' }), body: { getReader() { throw new Error('PRIVATE-SENTINEL'); } } }]) {
    await assert.rejects(() => readChatCompletionStream(response), { code: 'response_invalid' });
  }
});

test('controlled reasons distinguish gateway schema rejection points without weakening them', async () => {
  const missingType = { index: 0, id: 'synthetic-call', function: { name: 'list_files', arguments: '{}' } };
  for (const [text, reason] of [
    [stream(frame({ content: 'partial' }, 'PRIVATE-SENTINEL'), frame({}, 'stop')), 'finish_reason_invalid'],
    [stream(frame({ content: 'partial' }), frame({}, 'stop', { created: 2 })), 'created_changed'],
    [stream(frame({ tool_calls: [missingType] }, 'tool_calls')), 'tool_type_missing'],
    [stream(frame({ tool_calls: [{ ...call(0), index: '0' }] }, 'tool_calls')), 'tool_index_invalid'],
    [stream(frame({ tool_calls: [{ ...call(0), function: { name: 'list_files', arguments: {} } }] }, 'tool_calls')), 'tool_arguments_invalid'],
    [stream(frame({ content: 'complete' }, 'stop'), frame({}, 'stop')), 'choice_after_finish'],
    [stream(frame({}, 'stop', { usage: { completion_tokens: 1 } }), { choices: [], usage: { completion_tokens: 2 } }), 'usage_changed'],
  ]) await invalid(text, undefined, reason);
});

test('framing, completion and explicit provider errors have separate fixed reasons', async () => {
  for (const [text, reason] of [
    ['data: {PRIVATE-SENTINEL\n\n', 'json_invalid'],
    [event(frame({ content: 'complete' }, 'stop')), 'missing_done'],
    [stream(frame({ content: 'partial' })), 'missing_finish'],
    [event('[DONE]'), 'missing_choice'],
    [event({ error: { message: 'PRIVATE-SENTINEL' } }), 'error_frame'],
    ['event: error\ndata: PRIVATE-SENTINEL\n\n', 'error_event'],
    [stream(frame({ content: 'complete' }, 'stop')) + 'data: PRIVATE-SENTINEL', 'trailing_data'],
  ]) await invalid(text, undefined, reason);
  await invalid(Uint8Array.from([0xff]), undefined, 'utf8_invalid');
  await invalid('', { headers: { 'content-type': 'application/json' } }, 'mime_mismatch');
});

test('error reasons accept only a fixed vocabulary and never stringify unknown values', () => {
  const hostile = { toString() { throw new Error('PRIVATE-SENTINEL'); } };
  for (const value of ['PRIVATE-SENTINEL', hostile, null, { body: 'PRIVATE-SENTINEL' }]) {
    const error = new StreamResponseError('PRIVATE-SENTINEL', value);
    assert.equal(error.code, 'response_invalid');
    assert.equal(error.reason, 'invalid_response');
    assert.equal(safeStreamResponseReason(value), null);
    assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE-SENTINEL/);
  }
  const wrongCategory = new StreamResponseError('response_too_large', 'created_changed');
  assert.equal(wrongCategory.reason, 'wire_limit');
  assert.equal(new StreamResponseError('response_invalid', 'created_changed').reason, 'created_changed');
  assert.equal(safeStreamResponseReason('created_changed'), 'created_changed');
  assert.equal(safeStreamResponseReason('wire_limit'), 'wire_limit');
});

test('synthetic gateway tool stream tolerates empty non-final finishes and independent usage timestamp', async () => {
  const usage = { prompt_tokens: 12, completion_tokens: 17, total_tokens: 29,
    completion_tokens_details: { reasoning_tokens: 7 } };
  const gatewayFrame = (delta, finish = '', extra = {}) => frame(delta, finish, { created: 42, ...extra });
  const text = stream(
    gatewayFrame({ role: 'assistant', content: '', reasoning_content: 'SYNTHETIC-INTERNAL', function_call: null }),
    gatewayFrame({ tool_calls: [{ index: 0, id: 'synthetic-call-a', type: 'function',
      function: { name: 'report_sample', arguments: '' } }] }),
    gatewayFrame({ tool_calls: [{ index: 0, function: { arguments: '{"sample":' } }] }),
    gatewayFrame({ tool_calls: [{ index: 0, function: { arguments: '"SYNTHETIC"}' } }] }),
    gatewayFrame({ content: null, function_call: { name: '', arguments: '' } }, 'tool_calls', { usage }),
    { id: 'synthetic-stream-id', model: 'deepseek-synthetic-flash', object: 'chat.completion.chunk',
      created: 41, choices: [], usage },
  );
  const result = await readChatCompletionStream(responseFor(text, { chunkSize: 3 }));
  assert.equal(result.created, 42);
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(result.choices[0].message.tool_calls, [{ id: 'synthetic-call-a', type: 'function',
    function: { name: 'report_sample', arguments: '{"sample":"SYNTHETIC"}' } }]);
  assert.deepEqual(result.usage, usage);
});

test('empty legacy placeholders are ignored but no non-empty or unexpected legacy fields are accepted', async () => {
  for (const placeholder of [null, {}, { name: '' }, { arguments: '' }, { name: '', arguments: '' }]) {
    const result = await readChatCompletionStream(responseFor(stream(frame({ content: 'ready', function_call: placeholder }, 'stop'))));
    assert.equal(result.choices[0].message.content, 'ready');
    assert.equal(result.choices[0].message.function_call, undefined);
  }
  for (const placeholder of [{ name: 'nonempty' }, { arguments: '{}' }, { name: '', arguments: '', extra: null },
    { name: null }, { arguments: 0 }, []]) {
    await invalid(stream(frame({ content: 'ready', function_call: placeholder }, 'stop')), undefined, 'legacy_function_call');
  }
});

test('empty finish markers cannot satisfy completion or weaken non-empty finish validation', async () => {
  await invalid(stream(frame({ content: 'partial' }, '')), undefined, 'missing_finish');
  await invalid(event(frame({ content: 'partial' }, '')), undefined, 'missing_done');
  for (const finish of [' ', 'unknown', 0, false, {}]) {
    await invalid(stream(frame({ content: 'partial' }, finish)), undefined, 'finish_reason_invalid');
  }
});

test('usage timestamps remain numeric and choice timestamps remain consistent', async () => {
  for (const created of [null, -1, 1.5, '2', {}]) {
    await invalid(stream(frame({ content: 'ready' }, 'stop'), { choices: [], created, usage: { completion_tokens: 4 } }),
      undefined, 'created_invalid');
  }
  await invalid(stream(frame({ content: 'partial' }), frame({}, 'stop', { created: 2 })), undefined, 'created_changed');
});
