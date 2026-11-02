// A bounded SSE decoder for one Chat Completions choice. This module does not
// log, retry, fetch, execute tools, or expose a partially received completion.
// Protocol reference: https://api-docs.deepseek.com/api/create-chat-completion/
import { isDeepStrictEqual } from 'node:util';

const MiB = 1024 * 1024;
const MAX_WIRE_BYTES = 16 * MiB;
const MAX_TOOL_CALLS = 32;
const FINISH_REASONS = new Set(['stop', 'tool_calls', 'length', 'max_tokens',
  'max_output_tokens', 'content_filter', 'insufficient_system_resource', 'aborted', 'function_call']);
const COMPLETE_FINISHES = new Set(['stop', 'tool_calls']);
// Diagnostic reasons are fixed protocol labels, never response values, field
// contents, error text, tool arguments, or reasoning. Keep the public code stable.
const INVALID_REASONS = new Set([
  'invalid_response', 'byte_budget_invalid', 'response_body_missing', 'mime_mismatch',
  'reader_unavailable', 'chunk_type_invalid', 'utf8_invalid', 'json_invalid',
  'sse_event_invalid', 'error_event', 'error_frame', 'frame_invalid',
  'id_invalid', 'id_changed', 'model_invalid', 'model_changed',
  'created_invalid', 'created_changed', 'object_invalid', 'object_changed',
  'usage_invalid', 'usage_changed', 'usage_only_invalid', 'choices_invalid',
  'choice_after_finish', 'choice_invalid', 'choice_index_invalid', 'delta_invalid',
  'role_invalid', 'legacy_function_call', 'content_invalid', 'reasoning_invalid',
  'tool_calls_invalid', 'tool_count_limit', 'tool_call_invalid', 'tool_index_invalid',
  'tool_index_duplicate', 'tool_type_invalid', 'tool_function_invalid',
  'tool_id_invalid', 'tool_name_invalid', 'tool_arguments_invalid',
  'finish_reason_invalid', 'missing_choice', 'missing_finish', 'missing_done',
  'tool_index_gap', 'tool_id_missing', 'tool_type_missing', 'tool_name_missing',
  'tool_arguments_missing', 'tool_batch_missing', 'tool_id_duplicate',
  'data_after_done', 'trailing_data',
]);
const SIZE_REASONS = new Set(['content_length_limit', 'wire_limit']);

export function safeStreamResponseReason(value) {
  return INVALID_REASONS.has(value) || SIZE_REASONS.has(value) ? value : null;
}

export class StreamResponseError extends Error {
  constructor(code = 'response_invalid', reason) {
    super(code === 'response_too_large'
      ? 'The API response exceeded its byte limit.'
      : 'The API returned an invalid or incomplete event stream.');
    this.name = 'StreamResponseError';
    this.code = code === 'response_too_large' ? code : 'response_invalid';
    this.reason = this.code === 'response_too_large'
      ? SIZE_REASONS.has(reason) ? reason : 'wire_limit'
      : INVALID_REASONS.has(reason) ? reason : 'invalid_response';
  }
}

function invalid(reason) { throw new StreamResponseError('response_invalid', reason); }
function tooLarge(reason = 'wire_limit') { throw new StreamResponseError('response_too_large', reason); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function own(value, key) { return Object.hasOwn(value, key); }
function emptyLegacyPlaceholder(value) {
  return object(value) && Object.keys(value).every(key => key === 'name' || key === 'arguments')
    && (!own(value, 'name') || value.name === '')
    && (!own(value, 'arguments') || value.arguments === '');
}
function cancelQuietly(target) {
  try { void target?.cancel()?.catch(() => {}); }
  catch { /* Cleanup must never replace a result or wait on a stalled cancel. */ }
}

function createCompletion() {
  const identity = new Map();
  const contents = [];
  const reasoning = [];
  const calls = new Map();
  let hasContent = false;
  let hasReasoning = false;
  let hasChoice = false;
  let finish = null;
  let usage;

  function stable(frame, key, check) {
    if (!own(frame, key) || frame[key] === null) return;
    const value = frame[key];
    if (!check(value)) invalid(`${key}_invalid`);
    if (identity.has(key) && identity.get(key) !== value) invalid(`${key}_changed`);
    identity.set(key, value);
  }

  function appendText(delta, key, parts, reason) {
    if (!own(delta, key) || delta[key] === null) return false;
    if (typeof delta[key] !== 'string') invalid(reason);
    parts.push(delta[key]);
    return true;
  }

  function appendToolCalls(fragments) {
    if (fragments === undefined || fragments === null) return;
    if (!Array.isArray(fragments)) invalid('tool_calls_invalid');
    if (fragments.length > MAX_TOOL_CALLS) invalid('tool_count_limit');
    const seen = new Set();
    for (const fragment of fragments) {
      if (!object(fragment)) invalid('tool_call_invalid');
      if (!Number.isSafeInteger(fragment.index) || fragment.index < 0 || fragment.index >= MAX_TOOL_CALLS) {
        invalid('tool_index_invalid');
      }
      if (seen.has(fragment.index)) invalid('tool_index_duplicate');
      seen.add(fragment.index);
      let call = calls.get(fragment.index);
      if (!call) {
        if (calls.size >= MAX_TOOL_CALLS) invalid('tool_count_limit');
        call = { id: [], name: [], arguments: [], type: null, hasArguments: false };
        calls.set(fragment.index, call);
      }
      appendText(fragment, 'id', call.id, 'tool_id_invalid');
      if (fragment.type !== undefined && fragment.type !== null) {
        if (fragment.type !== 'function') invalid('tool_type_invalid');
        call.type = fragment.type;
      }
      if (fragment.function !== undefined && fragment.function !== null) {
        if (!object(fragment.function)) invalid('tool_function_invalid');
        appendText(fragment.function, 'name', call.name, 'tool_name_invalid');
        call.hasArguments = appendText(fragment.function, 'arguments', call.arguments, 'tool_arguments_invalid') || call.hasArguments;
      }
    }
  }

  function add(frame) {
    if (!object(frame)) invalid('frame_invalid');
    if (frame.error !== undefined && frame.error !== null || frame.type === 'error') invalid('error_frame');
    stable(frame, 'id', value => typeof value === 'string' && value.length > 0);
    stable(frame, 'model', value => typeof value === 'string' && value.length > 0);
    const usageOnly = Array.isArray(frame.choices) && frame.choices.length === 0;
    if (usageOnly) {
      // A gateway can timestamp its separate usage envelope independently. It
      // must still be a timestamp; it cannot change the choice's identity.
      if (own(frame, 'created') && (!Number.isSafeInteger(frame.created) || frame.created < 0)) invalid('created_invalid');
    } else stable(frame, 'created', value => Number.isSafeInteger(value) && value >= 0);
    stable(frame, 'object', value => value === 'chat.completion.chunk');
    if (frame.usage !== undefined && frame.usage !== null) {
      if (!object(frame.usage)) invalid('usage_invalid');
      if (usage !== undefined) {
        let same = false;
        try { same = isDeepStrictEqual(usage, frame.usage); } catch { invalid('usage_invalid'); }
        if (!same) invalid('usage_changed');
      }
      usage = frame.usage;
    }
    if (!Array.isArray(frame.choices) || frame.choices.length > 1) invalid('choices_invalid');
    // OpenAI-compatible gateways can send usage separately after the final
    // choice. DeepSeek's native API carries it on the final choice itself.
    if (!frame.choices.length) {
      if (!object(frame.usage)) invalid('usage_only_invalid');
      return;
    }
    const choice = frame.choices[0];
    if (finish !== null) invalid('choice_after_finish');
    if (!object(choice)) invalid('choice_invalid');
    if (choice.index !== 0) invalid('choice_index_invalid');
    if (!object(choice.delta)) invalid('delta_invalid');
    hasChoice = true;
    const delta = choice.delta;
    if (delta.role !== undefined && delta.role !== null && delta.role !== 'assistant') invalid('role_invalid');
    if (delta.function_call !== undefined && delta.function_call !== null
        && !emptyLegacyPlaceholder(delta.function_call)) invalid('legacy_function_call');
    hasContent = appendText(delta, 'content', contents, 'content_invalid') || hasContent;
    hasReasoning = appendText(delta, 'reasoning_content', reasoning, 'reasoning_invalid') || hasReasoning;
    appendToolCalls(delta.tool_calls);
    // Some gateways use an empty string for a non-final delta. It never counts
    // as a final finish and still requires a real finish before [DONE].
    if (choice.finish_reason !== undefined && choice.finish_reason !== null && choice.finish_reason !== '') {
      if (!FINISH_REASONS.has(choice.finish_reason)) invalid('finish_reason_invalid');
      finish = choice.finish_reason;
    }
  }

  function result() {
    if (!hasChoice) invalid('missing_choice');
    if (finish === null) invalid('missing_finish');
    const toolCalls = [...calls].sort(([left], [right]) => left - right).map(([index, value], position) => {
      const call = { id: value.id.join(''), type: value.type ?? 'function',
        function: { name: value.name.join(''), arguments: value.arguments.join('') } };
      // A length-limited tool message must reach the runtime as truncated, even
      // when its last tool call is unfinished. It must never be executed there.
      if (COMPLETE_FINISHES.has(finish)) {
        if (index !== position) invalid('tool_index_gap');
        if (!call.id) invalid('tool_id_missing');
        if (!value.type) invalid('tool_type_missing');
        if (!call.function.name) invalid('tool_name_missing');
        if (!value.hasArguments) invalid('tool_arguments_missing');
      }
      return call;
    });
    if (finish === 'tool_calls' && !toolCalls.length) invalid('tool_batch_missing');
    if (COMPLETE_FINISHES.has(finish)
        && new Set(toolCalls.map(call => call.id)).size !== toolCalls.length) invalid('tool_id_duplicate');
    return {
      ...(identity.has('id') ? { id: identity.get('id') } : {}),
      ...(identity.has('model') ? { model: identity.get('model') } : {}),
      ...(identity.has('created') ? { created: identity.get('created') } : {}),
      object: 'chat.completion',
      choices: [{ index: 0, finish_reason: finish, message: {
        role: 'assistant', content: hasContent ? contents.join('') : null,
        ...(hasReasoning ? { reasoning_content: reasoning.join('') } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      } }],
      ...(usage === undefined ? {} : { usage }),
    };
  }
  return { add, result };
}

/** Aggregate a complete bounded SSE response into the existing JSON contract.
 * Native reader failures are deliberately preserved for transport diagnostics.
 * The caller owns the shared request deadline and cancellation policy.
 */
export async function readChatCompletionStream(response, maximumBytes = 4 * MiB) {
  let reader;
  try {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_WIRE_BYTES) invalid('byte_budget_invalid');
    if (!response?.body || typeof response.body.getReader !== 'function') invalid('response_body_missing');
    const mime = response.headers?.get('content-type');
    if (typeof mime !== 'string' || mime.split(';', 1)[0].trim().toLowerCase() !== 'text/event-stream') invalid('mime_mismatch');
    const length = response.headers?.get('content-length');
    if (typeof length === 'string' && /^\d+$/.test(length) && Number(length) > maximumBytes) tooLarge('content_length_limit');
    try { reader = response.body.getReader(); } catch { invalid('reader_unavailable'); }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const completion = createCompletion();
    let wireBytes = 0;
    let done = false;
    let assembled;
    let skipLf = false;
    let lineTail = '';
    const lineParts = [];
    let eventName = '';
    let eventData = [];

    function dispatch() {
      if (eventName === 'error') invalid('error_event');
      if (eventName && eventName !== 'message') invalid('sse_event_invalid');
      eventName = '';
      if (!eventData.length) return;
      if (done) invalid('data_after_done');
      const data = eventData.join('\n');
      eventData = [];
      if (data.trim() === '[DONE]') {
        // Validate the final choice before accepting the protocol terminator.
        assembled = completion.result();
        done = true;
        return;
      }
      let frame;
      try { frame = JSON.parse(data); } catch { invalid('json_invalid'); }
      completion.add(frame);
    }

    function line(value) {
      if (value === '') { dispatch(); return; }
      if (value.startsWith(':')) return;
      if (done) invalid('data_after_done');
      const colon = value.indexOf(':');
      const field = colon < 0 ? value : value.slice(0, colon);
      let text = colon < 0 ? '' : value.slice(colon + 1);
      if (text.startsWith(' ')) text = text.slice(1);
      if (field === 'data') eventData.push(text);
      else if (field === 'event') eventName = text;
      // SSE id/retry and unrecognized fields have no completion semantics.
    }

    function append(value) {
      lineTail += value;
      // Keep one-byte network chunks from creating an unbounded fragment list,
      // without repeatedly scanning or copying the entire pending line.
      if (lineTail.length >= 8192) { lineParts.push(lineTail); lineTail = ''; }
    }

    function takeLine() {
      const value = lineParts.join('') + lineTail;
      lineParts.length = 0;
      lineTail = '';
      return value;
    }

    function feed(text) {
      let start = 0;
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (skipLf) {
          skipLf = false;
          if (code === 10) { start = index + 1; continue; }
        }
        if (code !== 10 && code !== 13) continue;
        append(text.slice(start, index));
        line(takeLine());
        start = index + 1;
        skipLf = code === 13;
      }
      append(text.slice(start));
    }

    function decode(value, final = false) {
      try { return final ? decoder.decode() : decoder.decode(value, { stream: true }); }
      catch { invalid('utf8_invalid'); }
    }

    while (true) {
      // Do not wrap this await: native failures retain their short error codes.
      const chunk = await reader.read();
      if (chunk.done) {
        feed(decode(undefined, true));
        if (lineParts.length || lineTail) line(takeLine());
        dispatch();
        if (!done) invalid('missing_done');
        return assembled;
      }
      if (!(chunk.value instanceof Uint8Array)) invalid('chunk_type_invalid');
      wireBytes += chunk.value.byteLength;
      if (wireBytes > maximumBytes) tooLarge();
      feed(decode(chunk.value));
      if (done) {
        // Inspect already received trailing bytes, then stop at [DONE] rather
        // than waiting for an HTTP connection that may remain open afterward.
        feed(decode(undefined, true));
        const tail = takeLine();
        if (tail && !tail.startsWith(':')) invalid('trailing_data');
        return assembled;
      }
    }
  } finally {
    if (reader) {
      cancelQuietly(reader);
      try { reader.releaseLock(); } catch { /* The original outcome wins. */ }
    } else cancelQuietly(response?.body);
  }
}
