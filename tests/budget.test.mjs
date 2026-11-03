import test from 'node:test';
import assert from 'node:assert/strict';

import { assessOutputBudget } from '../skills/deepseek-collaboration/scripts/deepseek-budget.mjs';

const EFFORT_ERROR = 'reasoningEffort must be one of: none, low, high, max';
const MAX_OUTPUT_ERROR =
  'maxOutputTokens must be a safe integer between 32 and 393216';
const MINIMUM_OUTPUT_ERROR =
  'minMaxReasoningOutputTokens must be undefined, null, or a safe integer between 32 and 393216';

function expectedResult({
  effort,
  requested,
  minimum,
  ok = true,
}) {
  return {
    ok,
    error_code: ok ? null : 'output_budget_insufficient',
    requested_output_tokens: requested,
    minimum_output_tokens: minimum,
    reasoning_effort: effort,
    reasoning_shares_output_budget: true,
  };
}

test('legacy max request without a policy remains allowed', () => {
  assert.deepStrictEqual(
    assessOutputBudget({
      reasoningEffort: 'max',
      maxOutputTokens: 4096,
    }),
    expectedResult({ effort: 'max', requested: 4096, minimum: null }),
  );

  assert.deepStrictEqual(
    assessOutputBudget({
      reasoningEffort: 'max',
      maxOutputTokens: 32,
    }),
    expectedResult({ effort: 'max', requested: 32, minimum: null }),
  );
});

test('max request below the configured minimum is denied without mutation', () => {
  const input = Object.freeze({
    reasoningEffort: 'max',
    maxOutputTokens: 4096,
    minMaxReasoningOutputTokens: 16384,
  });
  const snapshot = { ...input };

  assert.deepStrictEqual(
    assessOutputBudget(input),
    expectedResult({
      effort: 'max',
      requested: 4096,
      minimum: 16384,
      ok: false,
    }),
  );
  assert.deepStrictEqual(input, snapshot);
});

test('equal minimum is allowed and larger explicit requests are unchanged', () => {
  const cases = [
    { requested: 16384, minimum: 16384 },
    { requested: 16385, minimum: 16384 },
    { requested: 32768, minimum: 16384 },
    { requested: 393216, minimum: 16384 },
  ];

  for (const { requested, minimum } of cases) {
    assert.deepStrictEqual(
      assessOutputBudget({
        reasoningEffort: 'max',
        maxOutputTokens: requested,
        minMaxReasoningOutputTokens: minimum,
      }),
      expectedResult({ effort: 'max', requested, minimum }),
    );
  }
});

test('policy omitted, undefined, or null disables the minimum', () => {
  const cases = [
    { reasoningEffort: 'max', maxOutputTokens: 4096 },
    {
      reasoningEffort: 'max',
      maxOutputTokens: 4096,
      minMaxReasoningOutputTokens: undefined,
    },
    {
      reasoningEffort: 'max',
      maxOutputTokens: 4096,
      minMaxReasoningOutputTokens: null,
    },
  ];

  for (const input of cases) {
    assert.deepStrictEqual(
      assessOutputBudget(input),
      expectedResult({ effort: 'max', requested: 4096, minimum: null }),
    );
  }
});

test('non-max efforts are unaffected by a configured minimum', () => {
  for (const effort of ['none', 'low', 'high']) {
    for (const requested of [32, 4096]) {
      assert.deepStrictEqual(
        assessOutputBudget({
          reasoningEffort: effort,
          maxOutputTokens: requested,
          minMaxReasoningOutputTokens: 16384,
        }),
        expectedResult({ effort, requested, minimum: null }),
      );
    }
  }
});

test('invalid maxOutputTokens values throw fixed RangeErrors', () => {
  const invalidValues = [
    ['string', '4096'],
    ['NaN', Number.NaN],
    ['fraction', 4096.5],
    ['below range', 31],
    ['above range', 393217],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['boolean', true],
    ['bigint', 4096n],
    ['missing', undefined],
    ['null', null],
  ];

  for (const [label, value] of invalidValues) {
    assert.throws(
      () =>
        assessOutputBudget({
          reasoningEffort: 'max',
          maxOutputTokens: value,
        }),
      { name: 'RangeError', message: MAX_OUTPUT_ERROR },
      label,
    );
  }
});

test('invalid configured minimums throw fixed RangeErrors', () => {
  const invalidValues = [
    ['string', '16384'],
    ['NaN', Number.NaN],
    ['fraction', 16384.5],
    ['below range', 31],
    ['above range', 393217],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['boolean', false],
    ['bigint', 16384n],
  ];

  for (const [label, value] of invalidValues) {
    assert.throws(
      () =>
        assessOutputBudget({
          reasoningEffort: 'max',
          maxOutputTokens: 65536,
          minMaxReasoningOutputTokens: value,
        }),
      { name: 'RangeError', message: MINIMUM_OUTPUT_ERROR },
      label,
    );
  }

  assert.throws(
    () =>
      assessOutputBudget({
        reasoningEffort: 'low',
        maxOutputTokens: 4096,
        minMaxReasoningOutputTokens: 16384.5,
      }),
    { name: 'RangeError', message: MINIMUM_OUTPUT_ERROR },
  );
});

test('invalid reasoning efforts throw fixed RangeErrors', () => {
  const invalidValues = [
    ['empty string', ''],
    ['uppercase', 'MAX'],
    ['unsupported effort', 'medium'],
    ['padded string', ' max '],
    ['null', null],
    ['undefined', undefined],
    ['number', 0],
    ['boolean', false],
  ];

  for (const [label, value] of invalidValues) {
    assert.throws(
      () =>
        assessOutputBudget({
          reasoningEffort: value,
          maxOutputTokens: 4096,
        }),
      { name: 'RangeError', message: EFFORT_ERROR },
      label,
    );
  }
});
