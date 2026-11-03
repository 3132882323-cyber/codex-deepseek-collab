// Contract tests for the pure native Responses core.
//
// All data below is synthetic. No network, credentials, local paths, or real
// gateway behavior are involved.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NativeProtocolError,
  prepareNativeRequest,
  validateResponsesJson,
  validateResponsesSse,
} from '../skills/deepseek-collaboration/scripts/deepseek-native-core.mjs';

const POLICY = Object.freeze({
  model: 'deepseek-flash-test',
  plannedOutputTokens: 32768,
  minOutputTokens: 16384,
  maxOutputTokens: 278528,
});

function expectCode(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof NativeProtocolError && error.code === code,
  );
}

function baseRequest(overrides = {}) {
  return {
    model: POLICY.model,
    store: false,
    stream: true,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'synthetic request' }],
      },
    ],
    tools: [
      {
        type: 'function',
        name: 'synthetic_lookup',
        description: 'Synthetic test tool',
        parameters: { type: 'object', properties: {} },
      },
    ],
    ...overrides,
  };
}

function textResponse() {
  return {
    object: 'response',
    id: 'resp_synthetic_text',
    status: 'completed',
    output: [
      {
        type: 'reasoning',
        id: 'rs_synthetic_1',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'synthetic reasoning' }],
      },
      {
        type: 'message',
        id: 'msg_synthetic_1',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'synthetic answer',
            annotations: [],
          },
        ],
      },
    ],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  };
}

function functionResponse() {
  return {
    object: 'response',
    id: 'resp_synthetic_function',
    status: 'completed',
    output: [
      {
        type: 'function_call',
        id: 'fc_synthetic_1',
        call_id: 'call_synthetic_1',
        name: 'synthetic_lookup',
        arguments: '{"query":"synthetic"}',
        status: 'completed',
      },
    ],
  };
}

function customResponse() {
  return {
    object: 'response',
    id: 'resp_synthetic_custom',
    status: 'completed',
    output: [
      {
        type: 'custom_tool_call',
        id: 'ctc_synthetic_1',
        call_id: 'call_synthetic_2',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** End Patch',
        status: 'completed',
      },
    ],
  };
}

function sseData(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

test('prepare injects the default max reasoning effort and 32768 token budget', () => {
  const request = baseRequest();
  const prepared = prepareNativeRequest(request, POLICY);

  assert.deepEqual(prepared.reasoning, { effort: 'max' });
  assert.equal(prepared.max_output_tokens, POLICY.plannedOutputTokens);
  assert.equal(prepared.model, POLICY.model);
  assert.equal(prepared.stream, true);
  assert.equal(prepared.store, false);
  assert.equal(prepared.tools, request.tools);
});

test('prepare preserves an existing in-range budget and all compatible fields', () => {
  const image = { type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGlj' };
  const toolOutput = { type: 'function_call_output', call_id: 'call_x', output: 'synthetic' };
  const request = baseRequest({
    max_output_tokens: 20000,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'synthetic with image' }, image],
      },
      toolOutput,
    ],
    reasoning: { effort: 'max', summary: 'auto' },
    metadata: { synthetic: true },
  });
  const prepared = prepareNativeRequest(request, POLICY);

  assert.equal(prepared.max_output_tokens, 20000);
  assert.equal(prepared.reasoning, request.reasoning);
  assert.equal(prepared.input, request.input);
  assert.equal(prepared.input[0].content[1], image);
  assert.equal(prepared.input[1], toolOutput);
  assert.deepEqual(prepared.metadata, { synthetic: true });
});

test('prepare rejects budgets below the minimum, above the maximum, or non-integers', () => {
  expectCode(
    () => prepareNativeRequest(baseRequest({ max_output_tokens: 16383 }), POLICY),
    'BUDGET',
  );
  expectCode(
    () => prepareNativeRequest(baseRequest({ max_output_tokens: 278529 }), POLICY),
    'BUDGET',
  );
  expectCode(
    () => prepareNativeRequest(baseRequest({ max_output_tokens: 20000.5 }), POLICY),
    'BUDGET',
  );
  expectCode(
    () => prepareNativeRequest(baseRequest({ max_output_tokens: '20000' }), POLICY),
    'BUDGET',
  );
});

test('prepare does not raise a caller-provided budget and accepts exact bounds', () => {
  const lower = prepareNativeRequest(baseRequest({ max_output_tokens: 16384 }), POLICY);
  const upper = prepareNativeRequest(baseRequest({ max_output_tokens: 278528 }), POLICY);

  assert.equal(lower.max_output_tokens, 16384);
  assert.equal(upper.max_output_tokens, 278528);
});

test('prepare rejects non-max reasoning effort and a malformed reasoning field', () => {
  expectCode(
    () => prepareNativeRequest(baseRequest({ reasoning: { effort: 'high' } }), POLICY),
    'EFFORT',
  );
  expectCode(
    () => prepareNativeRequest(baseRequest({ reasoning: { effort: 'medium' } }), POLICY),
    'EFFORT',
  );
  expectCode(
    () => prepareNativeRequest(baseRequest({ reasoning: 'max' }), POLICY),
    'INPUT',
  );
});

test('prepare rejects the wrong model and a Pro-style policy', () => {
  expectCode(
    () => prepareNativeRequest(baseRequest({ model: 'deepseek-pro-test' }), POLICY),
    'MODEL',
  );
  expectCode(
    () => prepareNativeRequest(baseRequest({ model: 'deepseek-flash-test-alias' }), POLICY),
    'MODEL',
  );
  expectCode(
    () =>
      prepareNativeRequest(baseRequest(), {
        ...POLICY,
        model: 'deepseek-pro-test',
      }),
    'POLICY',
  );
});

test('prepare requires store=false and rejects response or conversation references', () => {
  expectCode(
    () => prepareNativeRequest(baseRequest({ store: true }), POLICY),
    'STORE',
  );
  expectCode(
    () => prepareNativeRequest(baseRequest({ store: undefined }), POLICY),
    'STORE',
  );
  expectCode(
    () => prepareNativeRequest(baseRequest({ previous_response_id: 'resp_previous' }), POLICY),
    'REFERENCE',
  );
  expectCode(
    () => prepareNativeRequest(baseRequest({ conversation: { id: 'conv_synthetic' } }), POLICY),
    'REFERENCE',
  );
  expectCode(
    () => prepareNativeRequest(baseRequest({ conversation: ['synthetic'] }), POLICY),
    'REFERENCE',
  );
});

test('prepare requires non-empty input or instructions and a plain object', () => {
  expectCode(
    () => prepareNativeRequest(baseRequest({ input: [] }), POLICY),
    'CONTENT',
  );
  expectCode(
    () => prepareNativeRequest(baseRequest({ input: '   ' }), POLICY),
    'CONTENT',
  );
  expectCode(
    () => prepareNativeRequest(baseRequest({ input: [], instructions: '' }), POLICY),
    'CONTENT',
  );
  expectCode(() => prepareNativeRequest([], POLICY), 'INPUT');
  assert.equal(prepareNativeRequest(baseRequest({ input: undefined, instructions: 'synthetic' }), POLICY).instructions, 'synthetic');

  const prepared = prepareNativeRequest(
    baseRequest({ input: [], instructions: 'synthetic instructions' }),
    POLICY,
  );
  assert.equal(prepared.instructions, 'synthetic instructions');
});

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

test('prepare never mutates the request or policy', () => {
  const request = deepFreeze(
    baseRequest({
      max_output_tokens: 20000,
      reasoning: { effort: 'max', summary: 'auto' },
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'immutable synthetic' }] },
      ],
    }),
  );
  const policy = deepFreeze({ ...POLICY });
  const beforeRequest = JSON.stringify(request);
  const beforePolicy = JSON.stringify(policy);

  const prepared = prepareNativeRequest(request, policy);

  assert.equal(JSON.stringify(request), beforeRequest);
  assert.equal(JSON.stringify(policy), beforePolicy);
  assert.notEqual(prepared, request);
  assert.equal(prepared.input, request.input);
});

test('errors use fixed messages and never reflect raw input', () => {
  const sentinel = 'SYNTHETIC_SENTINEL_DO_NOT_REFLECT';
  const request = baseRequest({ max_output_tokens: sentinel });

  try {
    prepareNativeRequest(request, POLICY);
    assert.fail('expected a protocol error');
  } catch (error) {
    assert.ok(error instanceof NativeProtocolError);
    assert.equal(error.code, 'BUDGET');
    assert.equal(error.message, 'Output token budget is outside the allowed range.');
    assert.equal(error.message.includes(sentinel), false);
  }

  const direct = new NativeProtocolError('INPUT', sentinel);
  assert.equal(direct.message, 'Input must be a plain JSON object.');
  assert.equal(direct.message.includes(sentinel), false);
});

test('validateResponsesJson accepts a complete text response and returns it intact', () => {
  const response = textResponse();
  const result = validateResponsesJson(response);

  assert.equal(result, response);
  assert.equal(result.output[1].content[0].text, 'synthetic answer');
  assert.deepEqual(result.usage, response.usage);
});

test('validateResponsesJson accepts complete function and custom tool calls', () => {
  const fnResponse = functionResponse();
  const custom = customResponse();

  assert.equal(validateResponsesJson(fnResponse), fnResponse);
  assert.equal(validateResponsesJson(custom), custom);
  assert.deepEqual(Object.keys(validateResponsesJson(fnResponse).output[0]), [
    'type',
    'id',
    'call_id',
    'name',
    'arguments',
    'status',
  ]);
});

test('validateResponsesJson rejects truncated or malformed function tool JSON', () => {
  const malformed = functionResponse();
  malformed.output[0].arguments = '{"query":';

  const nonObject = functionResponse();
  nonObject.output[0].arguments = '["synthetic"]';

  const truncatedItem = functionResponse();
  truncatedItem.output[0].status = 'incomplete';

  expectCode(() => validateResponsesJson(malformed), 'RESPONSE');
  expectCode(() => validateResponsesJson(nonObject), 'RESPONSE');
  expectCode(() => validateResponsesJson(truncatedItem), 'TRUNCATED');
});

test('validateResponsesJson rejects incomplete custom tool calls', () => {
  const wrongName = customResponse();
  wrongName.output[0].name = 'other_tool';

  const emptyInput = customResponse();
  emptyInput.output[0].input = '   ';

  const missingCallId = customResponse();
  delete missingCallId.output[0].call_id;

  expectCode(() => validateResponsesJson(wrongName), 'RESPONSE');
  expectCode(() => validateResponsesJson(emptyInput), 'RESPONSE');
  expectCode(() => validateResponsesJson(missingCallId), 'RESPONSE');
});

test('validateResponsesJson rejects reasoning-only success and empty output', () => {
  const reasoningOnly = textResponse();
  reasoningOnly.output = [reasoningOnly.output[0]];

  const empty = textResponse();
  empty.output = [];

  expectCode(() => validateResponsesJson(reasoningOnly), 'RESPONSE');
  expectCode(() => validateResponsesJson(empty), 'RESPONSE');
});

test('validateResponsesJson rejects failed, incomplete, error, and truncated statuses', () => {
  const incomplete = textResponse();
  incomplete.status = 'incomplete';

  const failed = textResponse();
  failed.status = 'failed';

  const withError = textResponse();
  withError.error = { code: 'synthetic_error', message: 'synthetic' };

  const missingStatus = textResponse();
  delete missingStatus.status;

  const nonCompletedItem = textResponse();
  nonCompletedItem.output[1].status = 'in_progress';

  expectCode(() => validateResponsesJson(incomplete), 'TRUNCATED');
  expectCode(() => validateResponsesJson(failed), 'TRUNCATED');
  expectCode(() => validateResponsesJson(withError), 'RESPONSE');
  expectCode(() => validateResponsesJson(missingStatus), 'RESPONSE');
  expectCode(() => validateResponsesJson(nonCompletedItem), 'RESPONSE');
});

test('validateResponsesJson rejects malformed message and unsupported item types', () => {
  const wrongRole = textResponse();
  wrongRole.output[1].role = 'user';

  const emptyText = textResponse();
  emptyText.output[1].content[0].text = '  ';

  const unsupported = textResponse();
  unsupported.output.push({ type: 'web_search_call', id: 'ws_1', status: 'completed' });

  const badId = textResponse();
  badId.output[1].id = '';

  expectCode(() => validateResponsesJson(wrongRole), 'RESPONSE');
  expectCode(() => validateResponsesJson(emptyText), 'RESPONSE');
  expectCode(() => validateResponsesJson(unsupported), 'RESPONSE');
  expectCode(() => validateResponsesJson(badId), 'RESPONSE');
});

test('validateResponsesSse accepts a complete stream with multiline data, CRLF, comments, and empty events', () => {
  const response = textResponse();
  const created = {
    type: 'response.created',
    response: { id: response.id, status: 'in_progress' },
  };
  const createdJson = JSON.stringify(created);
  const splitAt = createdJson.indexOf(',') + 1;

  const text = [
    ': synthetic keepalive',
    '',
    'event: response.created',
    `data: ${createdJson.slice(0, splitAt)}`,
    `data: ${createdJson.slice(splitAt)}`,
    '',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"synthetic"}',
    '',
    'event: response.completed',
    `data: ${JSON.stringify({ type: 'response.completed', response })}`,
    '',
    '',
  ].join('\r\n');

  const result = validateResponsesSse(text);
  assert.deepEqual(result.response, response);
  assert.equal(result.eventCount, 3);
});

test('validateResponsesSse accepts in_progress and common incremental events', () => {
  const response = functionResponse();
  const events = [
    sseData('response.created', {
      type: 'response.created',
      response: { id: response.id, status: 'in_progress' },
    }),
    sseData('response.in_progress', {
      type: 'response.in_progress',
      response: { id: response.id, status: 'in_progress' },
    }),
    sseData('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_synthetic_1', status: 'in_progress' },
    }),
    sseData('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: '{"query":',
    }),
    sseData('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      output_index: 0,
      arguments: '{"query":"synthetic"}',
    }),
    sseData('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: response.output[0],
    }),
    sseData('response.completed', { type: 'response.completed', response }),
  ];

  const result = validateResponsesSse(events.join(''));
  assert.deepEqual(result.response, response);
  assert.equal(result.eventCount, 7);
});

test('validateResponsesSse uses the final response for tool argument integrity', () => {
  const truncated = functionResponse();
  truncated.output[0].arguments = '{"query":';

  const text =
    sseData('response.created', {
      type: 'response.created',
      response: { id: truncated.id, status: 'in_progress' },
    }) +
    sseData('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      output_index: 0,
      arguments: '{"query":"synthetic"}',
    }) +
    sseData('response.completed', { type: 'response.completed', response: truncated });

  expectCode(() => validateResponsesSse(text), 'RESPONSE');
});

test('validateResponsesSse rejects streams without a terminal event', () => {
  const text =
    sseData('response.created', {
      type: 'response.created',
      response: { id: 'resp_synthetic_1', status: 'in_progress' },
    }) +
    sseData('response.in_progress', {
      type: 'response.in_progress',
      response: { id: 'resp_synthetic_1', status: 'in_progress' },
    });

  expectCode(() => validateResponsesSse(text), 'SSE_NO_TERMINAL');
});

test('validateResponsesSse rejects failed and incomplete terminal events', () => {
  const failed =
    sseData('response.created', {
      type: 'response.created',
      response: { id: 'resp_synthetic_1', status: 'in_progress' },
    }) +
    sseData('response.failed', {
      type: 'response.failed',
      response: { id: 'resp_synthetic_1', status: 'failed', error: { code: 'synthetic' } },
    });

  const incomplete =
    sseData('response.created', {
      type: 'response.created',
      response: { id: 'resp_synthetic_1', status: 'in_progress' },
    }) +
    sseData('response.incomplete', {
      type: 'response.incomplete',
      response: { id: 'resp_synthetic_1', status: 'incomplete' },
    });

  const topLevelError =
    sseData('response.created', {
      type: 'response.created',
      response: { id: 'resp_synthetic_1', status: 'in_progress' },
    }) + sseData('error', { type: 'error', error: { code: 'synthetic' } });

  expectCode(() => validateResponsesSse(failed), 'TRUNCATED');
  expectCode(() => validateResponsesSse(incomplete), 'TRUNCATED');
  expectCode(() => validateResponsesSse(topLevelError), 'SSE');
});

test('validateResponsesSse rejects a completed event whose response is not complete', () => {
  const incomplete = textResponse();
  incomplete.status = 'incomplete';

  const text =
    sseData('response.created', {
      type: 'response.created',
      response: { id: incomplete.id, status: 'in_progress' },
    }) + sseData('response.completed', { type: 'response.completed', response: incomplete });

  expectCode(() => validateResponsesSse(text), 'TRUNCATED');
});

test('validateResponsesSse rejects data after the terminal event', () => {
  const response = textResponse();
  const text =
    sseData('response.created', {
      type: 'response.created',
      response: { id: response.id, status: 'in_progress' },
    }) +
    sseData('response.completed', { type: 'response.completed', response }) +
    sseData('response.output_text.delta', {
      type: 'response.output_text.delta',
      delta: 'late synthetic data',
    });

  expectCode(() => validateResponsesSse(text), 'SSE_AFTER_TERMINAL');
});

test('validateResponsesSse rejects [DONE], mismatched events, invalid JSON, and unknown events', () => {
  const created =
    sseData('response.created', {
      type: 'response.created',
      response: { id: 'resp_synthetic_1', status: 'in_progress' },
    });

  const done = `${created}data: [DONE]\n\n`;
  const mismatch = sseData('response.output_text.delta', {
    type: 'response.in_progress',
    response: { id: 'resp_synthetic_1', status: 'in_progress' },
  });
  const invalidJson = 'event: response.created\ndata: {"type":\n\n';
  const unknown = sseData('response.synthetic_unknown', {
    type: 'response.synthetic_unknown',
  });

  expectCode(() => validateResponsesSse(done), 'SSE_DONE');
  expectCode(() => validateResponsesSse(created + mismatch), 'SSE');
  expectCode(() => validateResponsesSse(invalidJson), 'SSE');
  expectCode(() => validateResponsesSse(created + unknown), 'SSE_EVENT');
});
