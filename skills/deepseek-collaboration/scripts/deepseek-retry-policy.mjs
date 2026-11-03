/**
 * Pure transient-failure retry policy.
 *
 * Contract and safety boundaries:
 * - The caller supplies only already-sanitized error codes and controlled
 *   categories. This module never receives or inspects an Error object,
 *   `message`, stack, response payload, headers, request data, or credentials.
 * - `body` is code-gated below. Bad JSON, SSE parsing failures, and truncated
 *   payloads must not be reclassified as a retryable body transport failure.
 *   Only the explicit eligible codes can retry under `transport` or `body`.
 * - HTTP status handling belongs to existing response logic. `response`,
 *   `http_status`, `cooldown`, and `unknown` never retry here.
 * - `attempt` is the current, 1-based attempt. A retry is possible only while
 *   `attempt < maxAttempts`.
 * - Disabled and cancelled short-circuit before unrelated fields are
 *   validated, by design.
 * - The budget boundary is strict: `remaining > delay + 1` is required.
 *   Equality is a budget stop. Whenever a decision is not to retry,
 *   `delay_ms` is 0 because no wait is scheduled.
 * - The delay is exponential from the current attempt and capped:
 *   `min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1))`.
 * - Input is only read, never mutated. This module does no I/O, networking,
 *   timing, randomness, authentication, logging, or token accounting.
 */

const ELIGIBLE_CODES = new Set([
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT'
]);

const CONTROLLED_CATEGORIES = new Set([
  'transport',
  'body',
  'timeout',
  'response',
  'http_status',
  'cooldown',
  'unknown'
]);

const CODE_GATED_CATEGORIES = new Set(['transport', 'body']);

const REASONS = Object.freeze({
  retry: 'retry',
  disabled: 'disabled',
  cancelled: 'cancelled',
  attemptLimit: 'attempt limit',
  budgetStop: 'budget stop',
  category: 'category not retryable',
  code: 'code not eligible'
});

const ERRORS = Object.freeze({
  input: 'Retry policy input must be an object',
  type: 'Invalid retry policy input type',
  range: 'Retry policy input is out of range',
  category: 'Unsupported retry category'
});

function noRetry(reason) {
  return { retry: false, delay_ms: 0, reason };
}

function requireSafeInteger(value, minimum, maximum) {
  if (typeof value !== 'number') {
    throw new TypeError(ERRORS.type);
  }
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(ERRORS.range);
  }
}

/**
 * Decide whether one more attempt may be scheduled.
 *
 * @param {{
 *   enabled: boolean,
 *   code?: string | null,
 *   category: 'transport' | 'body' | 'timeout' | 'response' |
 *     'http_status' | 'cooldown' | 'unknown',
 *   attempt: number,
 *   maxAttempts: number,
 *   elapsedMs: number,
 *   totalTimeoutMs: number,
 *   retryBaseMs: number,
 *   retryMaxMs: number,
 *   cancelled?: boolean
 * }} input Sanitized metadata; no Error object or message is accepted.
 * @returns {{retry: boolean, delay_ms: number, reason: string}}
 * @throws {TypeError|RangeError} For invalid types or out-of-range values,
 *   using fixed messages that never include the offending value.
 */
export function decideTransientRetry(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(ERRORS.input);
  }

  const enabled = input.enabled;
  const cancelled = input.cancelled;

  if (typeof enabled !== 'boolean') {
    throw new TypeError(ERRORS.type);
  }
  if (cancelled !== undefined && typeof cancelled !== 'boolean') {
    throw new TypeError(ERRORS.type);
  }

  // Required early exits: no other input is consulted for these decisions.
  if (!enabled) {
    return noRetry(REASONS.disabled);
  }
  if (cancelled === true) {
    return noRetry(REASONS.cancelled);
  }

  const {
    code,
    category,
    attempt,
    maxAttempts,
    elapsedMs,
    totalTimeoutMs,
    retryBaseMs,
    retryMaxMs
  } = input;

  if (typeof category !== 'string') {
    throw new TypeError(ERRORS.type);
  }
  if (!CONTROLLED_CATEGORIES.has(category)) {
    throw new RangeError(ERRORS.category);
  }

  if (code !== undefined && code !== null && typeof code !== 'string') {
    throw new TypeError(ERRORS.type);
  }

  requireSafeInteger(attempt, 1, Number.MAX_SAFE_INTEGER);
  requireSafeInteger(maxAttempts, 1, 3);
  requireSafeInteger(elapsedMs, 0, Number.MAX_SAFE_INTEGER);
  requireSafeInteger(totalTimeoutMs, 0, Number.MAX_SAFE_INTEGER);
  requireSafeInteger(retryBaseMs, 1, 10_000);
  requireSafeInteger(retryMaxMs, 1, 60_000);

  if (retryBaseMs > retryMaxMs) {
    throw new RangeError(ERRORS.range);
  }

  if (!CODE_GATED_CATEGORIES.has(category) && category !== 'timeout') {
    return noRetry(REASONS.category);
  }

  if (CODE_GATED_CATEGORIES.has(category) && !ELIGIBLE_CODES.has(code)) {
    return noRetry(REASONS.code);
  }

  if (attempt >= maxAttempts) {
    return noRetry(REASONS.attemptLimit);
  }

  const delayMs = Math.min(
    retryMaxMs,
    retryBaseMs * 2 ** (attempt - 1)
  );
  const remainingMs = totalTimeoutMs - elapsedMs;

  if (remainingMs <= delayMs + 1) {
    return noRetry(REASONS.budgetStop);
  }

  return {
    retry: true,
    delay_ms: delayMs,
    reason: REASONS.retry
  };
}
