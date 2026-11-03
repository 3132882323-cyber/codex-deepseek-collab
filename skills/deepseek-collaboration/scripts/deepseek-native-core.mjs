// Pure validation/preparation core for a Codex -> native Responses integration.
//
// Deliberate boundaries:
// - No I/O, HTTP, authentication, retries, logging, or clock access.
// - Inputs are never mutated. Returned requests/responses are the caller's data.
// - Error messages are fixed strings. They never include prompts, reasoning,
//   response bodies, credentials, or other raw input.
// - validateResponsesJson returns the original, full response object after
//   validation. This is intentional: Codex must retain the complete response,
//   not a reconstructed or truncated copy, and no metadata is added to it.
// - validateResponsesSse assumes the caller has already read the entire stream
//   and bounded its size. It intentionally does no streaming or buffering limit.
//
// Protocol interpretation notes:
// - "Plain JSON object" means a non-array object whose prototype is
//   Object.prototype or null.
// - Item status is optional, but in a completed response an item may only be
//   marked "completed" (or omit status). Anything else would let a truncated
//   item ride along inside a nominally completed response.
// - A message's non-empty output_text is looked up in the standard Responses
//   content array (content[].type === "output_text", content[].text).
// - Native Responses SSE event names are required and must equal payload.type.
//   Comment-only/empty events are ignored by SSE framing. A data event after
//   the one completed terminal event is rejected. Comments/keepalive after the
//   terminal event are not data and are ignored.
// - The [DONE] sentinel is not part of the native Responses event set and is
//   rejected.

const ERROR_DEFINITIONS = Object.freeze({
  INPUT: 'Input must be a plain JSON object.',
  POLICY: 'Policy is invalid.',
  MODEL: 'Model is not allowed by this policy.',
  REFERENCE: 'Previous response and conversation references are not allowed.',
  STORE: 'Store must be false.',
  EFFORT: 'Reasoning effort must be max.',
  BUDGET: 'Output token budget is outside the allowed range.',
  CONTENT: 'Input or instructions must be non-empty.',
  RESPONSE: 'Response is not a valid completed response.',
  TRUNCATED: 'Response is incomplete or failed.',
  SSE: 'SSE payload is invalid.',
  SSE_DONE: 'SSE done marker is not allowed.',
  SSE_EVENT: 'SSE event type is not allowed.',
  SSE_AFTER_TERMINAL: 'SSE data appeared after response.completed.',
  SSE_NO_TERMINAL: 'SSE stream has no response.completed event.',
  SSE_NO_CREATED: 'SSE stream has no response.created event.',
});

/**
 * Protocol error with a fixed, non-reflective message selected by a short code.
 *
 * The second argument exists for call-site clarity, but the message is always
 * selected from ERROR_DEFINITIONS so no raw input can be reflected.
 */
export class NativeProtocolError extends Error {
  constructor(code, _message) {
    if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(ERROR_DEFINITIONS, code)) {
      throw new TypeError('Unknown NativeProtocolError code.');
    }
    super(ERROR_DEFINITIONS[code]);
    this.name = 'NativeProtocolError';
    this.code = code;
  }
}

const PROFILE_EFFORT = 'max';

const OUTPUT_ITEM_TYPES = new Set([
  'reasoning',
  'message',
  'function_call',
  'custom_tool_call',
]);

// Incremental events accepted by this core. Completeness and tool argument
// integrity are established only by the final response.completed response.
const SSE_INCREMENTAL_EVENTS = new Set([
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.custom_tool_call_input.delta',
  'response.custom_tool_call_input.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
]);

function fail(code) {
  throw new NativeProtocolError(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasNonEmptyInput(value) {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  return Array.isArray(value) && value.length > 0;
}

function isNonEmptyReference(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isPlainObject(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validatePolicy(policy) {
  if (!isPlainObject(policy)) {
    fail('POLICY');
  }

  // The exact allowed Flash ID is supplied by the authorized local profile.
  // Test identifiers are data, never a production route hard-coded here.
  if (typeof policy.model !== 'string' || !/^deepseek[\w.:-]*flash[\w.:-]*$/i.test(policy.model)
      || /pro|reasoner/i.test(policy.model)) {
    fail('POLICY');
  }

  const planned = policy.plannedOutputTokens;
  const minimum = policy.minOutputTokens;
  const maximum = policy.maxOutputTokens;

  if (
    !Number.isSafeInteger(planned) ||
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum < 16384 || maximum > 393216 ||
    maximum < minimum ||
    planned < minimum ||
    planned > maximum
  ) {
    fail('POLICY');
  }

  return { planned, minimum, maximum };
}

/**
 * Prepares a native Responses request without changing the caller's objects.
 *
 * This function does not send anything. It validates the Flash-only policy,
 * injects the explicit default reasoning effort and planned token budget only
 * when those fields are absent, and otherwise preserves all compatible fields.
 */
export function prepareNativeRequest(input, policy) {
  if (!isPlainObject(input)) {
    fail('INPUT');
  }

  const limits = validatePolicy(policy);

  if (input.model !== policy.model) {
    fail('MODEL');
  }

  if (isNonEmptyReference(input.previous_response_id) || isNonEmptyReference(input.conversation)) {
    fail('REFERENCE');
  }

  if (input.store !== false) {
    fail('STORE');
  }

  if (!hasNonEmptyInput(input.input) && !isNonEmptyString(input.instructions)) {
    fail('CONTENT');
  }

  let reasoning;
  if (!hasOwn(input, 'reasoning') || input.reasoning === undefined) {
    reasoning = { effort: PROFILE_EFFORT };
  } else {
    if (!isPlainObject(input.reasoning)) {
      fail('INPUT');
    }
    if (!hasOwn(input.reasoning, 'effort') || input.reasoning.effort === undefined) {
      reasoning = { ...input.reasoning, effort: PROFILE_EFFORT };
    } else if (input.reasoning.effort !== PROFILE_EFFORT) {
      fail('EFFORT');
    } else {
      reasoning = input.reasoning;
    }
  }

  let maxOutputTokens;
  if (!hasOwn(input, 'max_output_tokens') || input.max_output_tokens === undefined) {
    maxOutputTokens = limits.planned;
  } else {
    maxOutputTokens = input.max_output_tokens;
    if (
      !Number.isInteger(maxOutputTokens) ||
      maxOutputTokens < limits.minimum ||
      maxOutputTokens > limits.maximum
    ) {
      fail('BUDGET');
    }
  }

  return {
    ...input,
    reasoning,
    max_output_tokens: maxOutputTokens,
  };
}

function validateOptionalEnvelope(item) {
  if (hasOwn(item, 'id') && !isNonEmptyString(item.id)) {
    fail('RESPONSE');
  }
  if (hasOwn(item, 'status')) {
    if (item.status !== 'completed') {
      fail(item.status === 'failed' || item.status === 'incomplete' ? 'TRUNCATED' : 'RESPONSE');
    }
  }
}

function validateMessageItem(item) {
  if (item.role !== 'assistant' || !Array.isArray(item.content)) {
    fail('RESPONSE');
  }

  const hasOutputText = item.content.some(
    (part) =>
      isPlainObject(part) &&
      part.type === 'output_text' &&
      typeof part.text === 'string' &&
      part.text.trim().length > 0,
  );
  if (!hasOutputText) {
    fail('RESPONSE');
  }
}

function validateFunctionCallItem(item) {
  if (!isNonEmptyString(item.call_id) || !isNonEmptyString(item.name)) {
    fail('RESPONSE');
  }
  if (typeof item.arguments !== 'string') {
    fail('RESPONSE');
  }

  let parsed;
  try {
    parsed = JSON.parse(item.arguments);
  } catch {
    fail('RESPONSE');
  }
  if (!isPlainObject(parsed)) {
    fail('RESPONSE');
  }
}

function validateCustomToolCallItem(item) {
  if (item.name !== 'apply_patch' || !isNonEmptyString(item.call_id)) {
    fail('RESPONSE');
  }
  if (typeof item.input !== 'string' || item.input.trim().length === 0) {
    fail('RESPONSE');
  }
}

/**
 * Validates a complete Responses JSON object.
 *
 * Returns the original response object, including all output items and any
 * compatible fields, so Codex can continue from the untouched full response.
 */
export function validateResponsesJson(input) {
  if (!isPlainObject(input)) {
    fail('INPUT');
  }

  if (hasOwn(input, 'error') && input.error !== undefined && input.error !== null) {
    fail('RESPONSE');
  }

  if (input.status === 'failed' || input.status === 'incomplete') {
    fail('TRUNCATED');
  }
  if (input.object !== 'response' || input.status !== 'completed' || !Array.isArray(input.output) || input.output.length === 0) {
    fail('RESPONSE');
  }

  validateOptionalEnvelope(input);

  let substantiveItems = 0;
  const itemIds = new Set();
  const callIds = new Set();
  for (const item of input.output) {
    if (!isPlainObject(item) || !OUTPUT_ITEM_TYPES.has(item.type)) {
      fail('RESPONSE');
    }

    validateOptionalEnvelope(item);
    if (hasOwn(item, 'id')) {
      if (itemIds.has(item.id)) fail('RESPONSE');
      itemIds.add(item.id);
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      if (callIds.has(item.call_id)) fail('RESPONSE');
      callIds.add(item.call_id);
    }

    switch (item.type) {
      case 'reasoning':
        break;
      case 'message':
        validateMessageItem(item);
        substantiveItems += 1;
        break;
      case 'function_call':
        validateFunctionCallItem(item);
        substantiveItems += 1;
        break;
      case 'custom_tool_call':
        validateCustomToolCallItem(item);
        substantiveItems += 1;
        break;
      default:
        fail('RESPONSE');
    }
  }

  // Reasoning is retained but cannot be the sole proof of success.
  if (substantiveItems === 0) {
    fail('RESPONSE');
  }

  return input;
}

function parseSseEvents(text) {
  const events = [];
  let dataLines = [];
  let eventName = null;

  const dispatch = () => {
    if (dataLines.length > 0) {
      events.push({
        event: eventName,
        data: dataLines.join('\n'),
      });
    }
    dataLines = [];
    eventName = null;
  };

  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r\n|\r|\n/);

  for (const line of lines) {
    if (line === '') {
      dispatch();
      continue;
    }
    if (line.startsWith(':')) {
      continue;
    }

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }

    if (field === 'event') {
      eventName = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
    // id, retry, and unknown fields do not affect this validation.
  }

  // A dangling data block is incomplete even after an earlier terminal event.
  if (dataLines.length > 0) fail('SSE');
  return events;
}

function hasTopLevelError(payload) {
  return hasOwn(payload, 'error') && payload.error !== undefined && payload.error !== null;
}

/**
 * Validates an already fully-read, bounded native Responses SSE text.
 *
 * Returns the final full response (validated by validateResponsesJson) plus the
 * count of data events. Comments and empty events are not data events.
 */
export function validateResponsesSse(text) {
  if (typeof text !== 'string') {
    fail('SSE');
  }

  const events = parseSseEvents(text);
  let eventCount = 0;
  let sawCreated = false;
  let sawCompleted = false;
  let finalResponse;

  for (const entry of events) {
    // Everything after the terminal data event is forbidden, even another
    // completed event, a failed event, or an otherwise valid delta.
    if (sawCompleted) {
      fail('SSE_AFTER_TERMINAL');
    }

    eventCount += 1;

    if (entry.data.trim() === '[DONE]') {
      fail('SSE_DONE');
    }

    let payload;
    try {
      payload = JSON.parse(entry.data);
    } catch {
      fail('SSE');
    }

    if (!isPlainObject(payload) || !isNonEmptyString(payload.type)) {
      fail('SSE');
    }
    if (entry.event === null || entry.event !== payload.type) {
      fail('SSE');
    }

    const type = payload.type;

    if (type === 'error' || hasTopLevelError(payload)) {
      fail('SSE');
    }
    if (type === 'response.failed' || type === 'response.incomplete') {
      fail('TRUNCATED');
    }
    if (
      type !== 'response.completed' &&
      isPlainObject(payload.response) &&
      (payload.response.status === 'failed' || payload.response.status === 'incomplete')
    ) {
      fail('TRUNCATED');
    }

    if (type === 'response.created') {
      sawCreated = true;
      continue;
    }

    if (type === 'response.completed') {
      // This enforces status === "completed", a non-empty output, allowed
      // items, complete tool JSON, and a non-reasoning-only result.
      validateResponsesJson(payload.response);
      finalResponse = payload.response;
      sawCompleted = true;
      continue;
    }

    if (type === 'response.in_progress' || SSE_INCREMENTAL_EVENTS.has(type)) {
      continue;
    }

    fail('SSE_EVENT');
  }

  if (!sawCreated) {
    fail('SSE_NO_CREATED');
  }
  if (!sawCompleted) {
    fail('SSE_NO_TERMINAL');
  }

  return { response: finalResponse, eventCount };
}
