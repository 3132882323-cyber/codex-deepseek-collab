// Synthetic, offline contracts for Codex namespace adaptation. No credentials or I/O.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptNativeTools, NativeToolError }
  from '../skills/deepseek-collaboration/scripts/deepseek-native-tools.mjs';

const fn = (name, extra = {}) => ({ type: 'function', name, description: 'Synthetic tool.',
  parameters: { type: 'object', properties: { value: { type: 'string' } },
    required: ['value'], additionalProperties: false }, strict: true, ...extra });
const ns = (name, tools, extra = {}) => ({ type: 'namespace', name,
  description: 'Synthetic group.', tools, ...extra });
const body = (tools = [], extra = {}) => ({ model: 'deepseek-flash-test', tools,
  input: [{ role: 'user', content: 'Synthetic task at https://example.test.' }], ...extra });
const call = (name, extra = {}) => ({ type: 'function_call', id: 'fc_synthetic',
  call_id: 'call_synthetic', name, arguments: '{"value":"synthetic"}', status: 'completed', ...extra });
const response = (...output) => ({ id: 'resp_synthetic', object: 'response',
  status: 'completed', output, usage: { output_tokens: 7 }, metadata: { synthetic: true } });

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function code(operation, expected) {
  assert.throws(operation, error => error instanceof NativeToolError && error.code === expected);
}

test('top-level functions/custom apply_patch, images, reasoning, and response fields are unchanged', () => {
  const input = body([fn('lookup'), { type: 'custom', name: 'apply_patch',
    description: 'Synthetic patch tool.', format: { type: 'grammar', syntax: 'lark', definition: 'synthetic' } }], {
    stream: true, tool_choice: 'auto', input: [
      { type: 'reasoning', id: 'rs_synthetic', encrypted_content: 'synthetic opaque value' },
      { role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/image.png' }] },
      call('lookup'), { type: 'function_call_output', call_id: 'call_synthetic', output: ['synthetic'] },
    ],
  });
  const before = structuredClone(input);
  freeze(input);
  const adapted = adaptNativeTools(input);
  assert.deepEqual(adapted.request, before);
  assert.notEqual(adapted.request.tools[0].parameters, input.tools[0].parameters);
  const upstream = freeze(response(call('lookup'), { type: 'custom_tool_call',
    name: 'apply_patch', input: 'synthetic patch', call_id: 'call_patch' }));
  assert.deepEqual(adapted.restoreResponse(upstream), upstream);
  assert.deepEqual(input, before);
});

test('namespace functions retain exact schemas and full MCP names, and same names in two groups stay distinct', () => {
  const mcpName = 'mcp__synthetic__lookup_reference';
  const input = body([ns('collaboration', [fn('spawn_agent')]),
    ns('mcp__synthetic', [fn(mcpName, { strict: false })]),
    ns('first', [fn('lookup')]), ns('second', [fn('lookup')])]);
  const before = structuredClone(input);
  const { request, restoreResponse } = adaptNativeTools(freeze(input));
  assert.equal(request.tools.length, 4);
  assert.equal(new Set(request.tools.map(tool => tool.name)).size, 4);
  request.tools.forEach(tool => {
    assert.equal(tool.type, 'function');
    assert.match(tool.name, /^dsns_[a-f0-9]{32}$/);
    assert.ok(tool.description.includes('Synthetic group.') && tool.description.includes('Synthetic tool.'));
  });
  assert.deepEqual(request.tools[1].parameters, input.tools[1].tools[0].parameters);
  assert.equal(request.tools[1].strict, false);
  const restored = restoreResponse(freeze(response(...request.tools.map((tool, i) => call(tool.name, {
    id: `fc_${i}`, call_id: `call_${i}`, extra_metadata: { synthetic: i },
  })))));
  assert.deepEqual(restored.output.map(item => [item.namespace, item.name]), [
    ['collaboration', 'spawn_agent'], ['mcp__synthetic', mcpName], ['first', 'lookup'], ['second', 'lookup'],
  ]);
  assert.deepEqual(restored.output[1].extra_metadata, { synthetic: 1 });
  assert.equal(restored.output[1].call_id, 'call_1');
  assert.equal(restored.output[1].arguments, '{"value":"synthetic"}');
  assert.deepEqual(input, before);
});

test('aliases are stable across catalog order and description changes', () => {
  const one = adaptNativeTools(body([ns('first', [fn('lookup')]), ns('second', [fn('lookup')])]));
  const two = adaptNativeTools(body([ns('second', [fn('lookup')], { description: 'Changed.' }),
    ns('first', [fn('lookup', { description: 'Changed.' })])]));
  assert.equal(one.request.tools[0].name, two.request.tools[1].name);
  assert.equal(one.request.tools[1].name, two.request.tools[0].name);
});

test('upstream top-level names are constrained while namespace identities remain exact and bounded', () => {
  for (const name of ['invalid.dot', 'invalid:colon', 'has space', 'x'.repeat(129)]) {
    code(() => adaptNativeTools(body([fn(name)])), 'native_tools_invalid');
  }
  const longTopName = 'x'.repeat(128);
  assert.equal(adaptNativeTools(body([fn(longTopName)])).request.tools[0].name, longTopName);
  const group = { type: 'namespace', name: 'namespace.with:punctuation', tools: [fn('mcp.full:name')] };
  const adapted = adaptNativeTools(body([group]));
  const restored = adapted.restoreResponse(response(call(adapted.request.tools[0].name))).output[0];
  assert.equal(restored.namespace, group.name);
  assert.equal(restored.name, 'mcp.full:name');
  assert.ok(!adapted.request.tools[0].description.includes('undefined'));
  for (const tools of [[ns('x'.repeat(513), [fn('lookup')])],
    [ns('group', [fn('x'.repeat(513))])], [ns('字'.repeat(171), [fn('lookup')])]]) {
    code(() => adaptNativeTools(body(tools)), 'native_tools_invalid');
  }
});

test('history round-trips namespaced calls without expanding the current response allowlist', () => {
  const first = adaptNativeTools(body([ns('collaboration', [fn('spawn_agent')])]));
  const alias = first.request.tools[0].name;
  const nativeCall = first.restoreResponse(response(call(alias))).output[0];
  const output = { type: 'function_call_output', call_id: nativeCall.call_id,
    output: [{ type: 'input_text', text: 'Synthetic result.' }], namespace: 'leave_output_unchanged' };
  const input = freeze(body([fn('lookup')], { input: [nativeCall, output,
    call('lookup'), call('lookup', { namespace: '' })] }));
  const second = adaptNativeTools(input);
  assert.equal(second.request.input[0].name, alias);
  assert.equal(Object.hasOwn(second.request.input[0], 'namespace'), false);
  assert.deepEqual(second.request.input[1], output);
  assert.deepEqual(second.request.input[2], input.input[2]);
  assert.deepEqual(second.request.input[3], input.input[3]);
  code(() => second.restoreResponse(response(call(alias))), 'native_tool_unknown');
  assert.equal(second.restoreResponse(response(call('lookup'))).output[0].name, 'lookup');
});

test('unknown aliases, ordinary names, child short names, and upstream namespaces are refused', () => {
  const adapted = adaptNativeTools(body([fn('lookup'), ns('collaboration', [fn('spawn_agent')])]));
  const alias = adapted.request.tools[1].name;
  for (const item of [call('dsns_unknown'), call('unknown'), call('spawn_agent'),
    call(alias, { namespace: 'collaboration' }), call('lookup', { namespace: 'fake' })]) {
    code(() => adapted.restoreResponse(freeze(response(item))), 'native_tool_unknown');
  }
  assert.equal(adapted.restoreResponse(response(call('lookup', { namespace: null }))).output[0].namespace, null);
});

test('duplicate namespaces, child names, top names, and native default-namespace identities are refused', () => {
  for (const tools of [
    [ns('same', [fn('one')]), ns('same', [fn('two')])],
    [ns('same', [fn('duplicate'), fn('duplicate')])],
    [fn('duplicate'), fn('duplicate')],
    [fn('apply_patch'), { type: 'custom', name: 'apply_patch' }],
    [fn('lookup'), ns('functions', [fn('lookup')])],
  ]) code(() => adaptNativeTools(body(tools)), 'native_tools_conflict');
});

test('generated alias collisions with top-level tools are refused in either ordering and in history', () => {
  const group = ns('collaboration', [fn('spawn_agent')]);
  const alias = adaptNativeTools(body([group])).request.tools[0].name;
  for (const tools of [[fn(alias), group], [group, fn(alias)]]) {
    code(() => adaptNativeTools(body(tools)), 'native_tools_conflict');
  }
  code(() => adaptNativeTools(body([fn(alias)], { input: [call('spawn_agent', {
    namespace: 'collaboration',
  })] })), 'native_tools_conflict');
});

test('tool_choice strings pass, and named choices must resolve to currently declared functions', () => {
  const tools = [fn('lookup'), ns('collaboration', [fn('spawn_agent')])];
  for (const choice of ['auto', 'none', 'required']) {
    assert.equal(adaptNativeTools(body(tools, { tool_choice: choice })).request.tool_choice, choice);
  }
  const named = { type: 'function', namespace: 'collaboration', name: 'spawn_agent' };
  const adapted = adaptNativeTools(freeze(body(tools, { tool_choice: named })));
  assert.deepEqual(adapted.request.tool_choice, { type: 'function', name: adapted.request.tools[1].name });
  assert.deepEqual(named, { type: 'function', namespace: 'collaboration', name: 'spawn_agent' });
  const plainChoice = { type: 'function', name: 'lookup' };
  assert.deepEqual(adaptNativeTools(body(tools, { tool_choice: plainChoice })).request.tool_choice, plainChoice);
  for (const choice of [{ type: 'function', name: 'spawn_agent' },
    { type: 'function', namespace: 'missing', name: 'spawn_agent' },
    { type: 'function', namespace: 'collaboration', name: 'missing' }]) {
    code(() => adaptNativeTools(body(tools, { tool_choice: choice })), 'native_tool_unknown');
  }
  for (const choice of [null, 'any', { type: 'auto' }, { type: 'custom', name: 'apply_patch' },
    { type: 'function', name: 'lookup', allowed_tools: [] }]) {
    code(() => adaptNativeTools(body(tools, { tool_choice: choice })), 'native_tools_unsupported');
  }
});

test('unknown tool types and namespace custom tools are rejected instead of disappearing', () => {
  for (const tools of [[{ type: 'web_search' }], [{ type: 'custom', name: 'other_custom' }],
    [ns('group', [{ type: 'custom', name: 'apply_patch' }])],
    [ns('group', [{ type: 'namespace', name: 'nested', tools: [] }])]]) {
    code(() => adaptNativeTools(body(tools)), 'native_tools_unsupported');
  }
});

test('malformed data produces fixed errors without reflecting caller data', () => {
  for (const input of [null, [], body({}), body(null), body([null]), body([fn('')]),
    body([ns('group', null)]), body([ns('group', [fn('lookup')], { description: null })]),
    body([], { input: [call('lookup', { namespace: 7 })] })]) {
    code(() => adaptNativeTools(input), 'native_tools_invalid');
  }
  const adapted = adaptNativeTools(body());
  code(() => adapted.restoreResponse({ output: {} }), 'native_tools_invalid');
  assert.throws(() => adapted.restoreResponse(response(call('SYNTHETIC-PRIVATE-TOOL'))), error => {
    assert.equal(error.code, 'native_tool_unknown');
    assert.equal(error.message, 'The selected native tool is not declared.');
    assert.ok(!error.message.includes('SYNTHETIC-PRIVATE-TOOL'));
    return true;
  });
  assert.equal(new NativeToolError('SYNTHETIC-PRIVATE-ERROR').code, 'native_tools_invalid');
  assert.equal(new NativeToolError({}).code, 'native_tools_invalid');
});

test('a request without tools retains its shape and cannot restore a function call', () => {
  const input = freeze({ model: 'deepseek-flash-test', input: 'Synthetic task.' });
  const adapted = adaptNativeTools(input);
  assert.deepEqual(adapted.request, input);
  assert.equal(Object.hasOwn(adapted.request, 'tools'), false);
  code(() => adapted.restoreResponse(response(call('lookup'))), 'native_tool_unknown');
});
