const REASONING_EFFORTS = new Set(['none', 'low', 'high', 'max']);
const MIN_OUTPUT_TOKENS = 32;
const MAX_OUTPUT_TOKENS = 393216;

const REASONING_EFFORT_ERROR =
  'reasoningEffort must be one of: none, low, high, max';
const MAX_OUTPUT_TOKENS_ERROR =
  'maxOutputTokens must be a safe integer between 32 and 393216';
const MINIMUM_OUTPUT_TOKENS_ERROR =
  'minMaxReasoningOutputTokens must be undefined, null, or a safe integer between 32 and 393216';

function isOutputTokenLimit(value) {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_OUTPUT_TOKENS &&
    value <= MAX_OUTPUT_TOKENS
  );
}

export function assessOutputBudget({
  reasoningEffort,
  maxOutputTokens,
  minMaxReasoningOutputTokens,
} = {}) {
  if (!REASONING_EFFORTS.has(reasoningEffort)) {
    throw new RangeError(REASONING_EFFORT_ERROR);
  }

  if (!isOutputTokenLimit(maxOutputTokens)) {
    throw new RangeError(MAX_OUTPUT_TOKENS_ERROR);
  }

  const hasConfiguredMinimum =
    minMaxReasoningOutputTokens !== undefined &&
    minMaxReasoningOutputTokens !== null;

  if (hasConfiguredMinimum && !isOutputTokenLimit(minMaxReasoningOutputTokens)) {
    throw new RangeError(MINIMUM_OUTPUT_TOKENS_ERROR);
  }

  const minimumOutputTokens =
    reasoningEffort === 'max' && hasConfiguredMinimum
      ? minMaxReasoningOutputTokens
      : null;

  const ok =
    minimumOutputTokens === null || maxOutputTokens >= minimumOutputTokens;

  return {
    ok,
    error_code: ok ? null : 'output_budget_insufficient',
    requested_output_tokens: maxOutputTokens,
    minimum_output_tokens: minimumOutputTokens,
    reasoning_effort: reasoningEffort,
    reasoning_shares_output_budget: true,
  };
}
