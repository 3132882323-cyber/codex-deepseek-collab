import test from 'node:test';
import assert from 'node:assert/strict';

import { decideTransientRetry } from '../skills/deepseek-collaboration/scripts/deepseek-retry-policy.mjs';

const ELIGIBLE_CODES = Object.freeze([
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT'
]);

const RETRY = 'retry';
const DISABLED = 'disabled';
const CANCELLED = 'cancelled';
const ATTEMPT_LIMIT = 'attempt limit';
const BUDGET_STOP = 'budget stop';
const CATEGORY_BLOCKED = 'category not retryable';
const CODE_BLOCKED = 'code not eligible';

function makeInput(overrides = {}) {
  return {
    enabled: true,
    code: 'ECONNRESET',
    category: 'transport',
    attempt: 1,
    maxAttempts: 3,
    elapsedMs: 0,
    totalTimeoutMs: 10_000,
    retryBaseMs: 200,
    retryMaxMs: 2_000,
    cancelled: false,
    ...overrides
  };
}

function expectRetry(result, delayMs) {
  assert.deepEqual(result, {
    retry: true,
    delay_ms: delayMs,
    reason: RETRY
  });
}

function expectNoRetry(result, reason) {
  assert.deepEqual(result, {
    retry: false,
    delay_ms: 0,
    reason
  });
}

test('retries every eligible code and timeout without a code', () => {
  for (const [index, code] of ELIGIBLE_CODES.entries()) {
    const category = index % 2 === 0 ? 'transport' : 'body';
    expectRetry(decideTransientRetry(makeInput({ code, category })), 200);
  }

  expectRetry(
    decideTransientRetry(makeInput({ category: 'timeout', code: undefined })),
    200
  );
  expectRetry(
    decideTransientRetry(makeInput({ category: 'timeout', code: null })),
    200
  );
});

test('uses a 1-based exponential delay and enforces the attempt cap', () => {
  expectRetry(
    decideTransientRetry(
      makeInput({ attempt: 1, maxAttempts: 3, retryBaseMs: 125, retryMaxMs: 500 })
    ),
    125
  );
  expectRetry(
    decideTransientRetry(
      makeInput({ attempt: 2, maxAttempts: 3, retryBaseMs: 125, retryMaxMs: 500 })
    ),
    250
  );
  expectRetry(
    decideTransientRetry(
      makeInput({ attempt: 2, maxAttempts: 3, retryBaseMs: 200, retryMaxMs: 300 })
    ),
    300
  );

  expectNoRetry(
    decideTransientRetry(makeInput({ attempt: 1, maxAttempts: 1 })),
    ATTEMPT_LIMIT
  );
  expectNoRetry(
    decideTransientRetry(makeInput({ attempt: 2, maxAttempts: 2 })),
    ATTEMPT_LIMIT
  );
  expectNoRetry(
    decideTransientRetry(makeInput({ attempt: 3, maxAttempts: 3 })),
    ATTEMPT_LIMIT
  );
});

test('requires remaining budget to be strictly greater than delay + 1ms', () => {
  expectNoRetry(
    decideTransientRetry(makeInput({ totalTimeoutMs: 201 })),
    BUDGET_STOP
  );
  expectRetry(
    decideTransientRetry(makeInput({ totalTimeoutMs: 202 })),
    200
  );

  expectNoRetry(
    decideTransientRetry(
      makeInput({ elapsedMs: 50, totalTimeoutMs: 251 })
    ),
    BUDGET_STOP
  );
  expectRetry(
    decideTransientRetry(
      makeInput({ elapsedMs: 50, totalTimeoutMs: 252 })
    ),
    200
  );

  expectNoRetry(
    decideTransientRetry(makeInput({ elapsedMs: 0, totalTimeoutMs: 0 })),
    BUDGET_STOP
  );
});

test('short-circuits disabled and cancelled decisions', () => {
  expectNoRetry(decideTransientRetry({ enabled: false }), DISABLED);
  expectNoRetry(
    decideTransientRetry({ enabled: true, cancelled: true }),
    CANCELLED
  );
  expectNoRetry(
    decideTransientRetry(makeInput({ cancelled: true })),
    CANCELLED
  );
  expectRetry(
    decideTransientRetry(makeInput({ cancelled: false })),
    200
  );
  expectRetry(
    decideTransientRetry(makeInput({ cancelled: undefined })),
    200
  );
});

test('never retries response-like categories', () => {
  for (const category of ['response', 'http_status', 'cooldown', 'unknown']) {
    expectNoRetry(
      decideTransientRetry(
        makeInput({ category, code: 'ECONNRESET', attempt: 1 })
      ),
      CATEGORY_BLOCKED
    );
  }
});

test('only exact eligible codes may retry, including under body', () => {
  const blockedCodes = [
    'ERR_BAD_JSON',
    'ERR_SSE_PARSE',
    'ERR_TRUNCATED',
    'econnreset',
    ' ECONNRESET',
    'ECONNRESET ',
    'UND_ERR_SOCKET_EXTRA'
  ];

  for (const code of blockedCodes) {
    expectNoRetry(
      decideTransientRetry(makeInput({ category: 'body', code })),
      CODE_BLOCKED
    );
  }

  expectNoRetry(
    decideTransientRetry(makeInput({ category: 'body', code: undefined })),
    CODE_BLOCKED
  );
  expectNoRetry(
    decideTransientRetry(makeInput({ category: 'transport', code: 'ERR_BAD_JSON' })),
    CODE_BLOCKED
  );
});

test('rejects non-object input', () => {
  for (const input of [undefined, null, [], 'synthetic', 1, true]) {
    assert.throws(() => decideTransientRetry(input), TypeError);
  }
});

test('rejects invalid boolean fields', () => {
  for (const enabled of [undefined, null, 0, 1, 'true', {}, []]) {
    assert.throws(
      () => decideTransientRetry(makeInput({ enabled })),
      TypeError
    );
  }

  for (const cancelled of [null, 0, 1, 'false', {}, []]) {
    assert.throws(
      () => decideTransientRetry(makeInput({ cancelled })),
      TypeError
    );
  }
});

test('rejects invalid numeric values and retry ranges', () => {
  const invalidCases = [
    [{ attempt: 0 }, RangeError],
    [{ attempt: -1 }, RangeError],
    [{ attempt: 1.5 }, RangeError],
    [{ attempt: Number.NaN }, RangeError],
    [{ attempt: Number.POSITIVE_INFINITY }, RangeError],
    [{ attempt: '1' }, TypeError],
    [{ attempt: true }, TypeError],
    [{ maxAttempts: 0 }, RangeError],
    [{ maxAttempts: 4 }, RangeError],
    [{ maxAttempts: 2.5 }, RangeError],
    [{ maxAttempts: Number.NaN }, RangeError],
    [{ maxAttempts: Number.POSITIVE_INFINITY }, RangeError],
    [{ maxAttempts: '3' }, TypeError],
    [{ maxAttempts: true }, TypeError],
    [{ elapsedMs: -1 }, RangeError],
    [{ elapsedMs: 1.5 }, RangeError],
    [{ elapsedMs: Number.NaN }, RangeError],
    [{ elapsedMs: Number.POSITIVE_INFINITY }, RangeError],
    [{ elapsedMs: '0' }, TypeError],
    [{ elapsedMs: false }, TypeError],
    [{ totalTimeoutMs: -1 }, RangeError],
    [{ totalTimeoutMs: 1.5 }, RangeError],
    [{ totalTimeoutMs: Number.NaN }, RangeError],
    [{ totalTimeoutMs: Number.POSITIVE_INFINITY }, RangeError],
    [{ totalTimeoutMs: '0' }, TypeError],
    [{ totalTimeoutMs: null }, TypeError],
    [{ retryBaseMs: 0 }, RangeError],
    [{ retryBaseMs: 10_001 }, RangeError],
    [{ retryBaseMs: 1.5 }, RangeError],
    [{ retryBaseMs: Number.NaN }, RangeError],
    [{ retryBaseMs: Number.POSITIVE_INFINITY }, RangeError],
    [{ retryBaseMs: '1' }, TypeError],
    [{ retryBaseMs: true }, TypeError],
    [{ retryMaxMs: 0 }, RangeError],
    [{ retryMaxMs: 60_001 }, RangeError],
    [{ retryMaxMs: 1.5 }, RangeError],
    [{ retryMaxMs: Number.NaN }, RangeError],
    [{ retryMaxMs: Number.POSITIVE_INFINITY }, RangeError],
    [{ retryMaxMs: '1' }, TypeError],
    [{ retryMaxMs: false }, TypeError],
    [{ retryBaseMs: 501, retryMaxMs: 500 }, RangeError]
  ];

  for (const [overrides, ErrorType] of invalidCases) {
    assert.throws(
      () => decideTransientRetry(makeInput(overrides)),
      ErrorType
    );
  }
});

test('rejects malformed category and code types', () => {
  for (const category of [undefined, null, 1, true, {}, []]) {
    assert.throws(
      () => decideTransientRetry(makeInput({ category })),
      TypeError
    );
  }

  assert.throws(
    () => decideTransientRetry(makeInput({ category: 'other' })),
    RangeError
  );

  for (const code of [1, true, {}, []]) {
    assert.throws(
      () => decideTransientRetry(makeInput({ code })),
      TypeError
    );
  }
});

test('uses fixed error messages without echoing input values', () => {
  const marker = 'synthetic-marker';

  assert.throws(
    () => decideTransientRetry(makeInput({ attempt: marker })),
    (error) => error instanceof TypeError && !error.message.includes(marker)
  );

  assert.throws(
    () => decideTransientRetry(makeInput({ retryBaseMs: 10_001 })),
    (error) => error instanceof RangeError && !error.message.includes('10001')
  );
});

test('does not mutate a frozen input', () => {
  const input = Object.freeze(
    makeInput({
      attempt: 2,
      retryBaseMs: 125,
      retryMaxMs: 500,
      elapsedMs: 25,
      totalTimeoutMs: 5_000
    })
  );
  const snapshot = { ...input };

  expectRetry(decideTransientRetry(input), 250);
  assert.deepEqual(input, snapshot);
  assert.equal(Object.isFrozen(input), true);
});
