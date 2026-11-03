import vendor from './vendor/undici-agent.cjs';

const { Agent } = vendor;
const MAX_TIMEOUT_MS = 86_400_000;
const INVALID_TIMEOUT = 'timeoutMs must be a safe integer between 1 and 86400000';

/**
 * Create one private transport for one long-task request attempt.
 *
 * Node's fetch passes its own 300000 ms header and body idle timeouts through
 * dispatch options. Replace both values before Undici sees them, so the
 * configured long-task timeout governs the actual request.
 */
export function createLongTaskDispatcher(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(INVALID_TIMEOUT);
  }

  const agent = new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connect: { timeout: timeoutMs },
  });
  const dispatcher = Object.freeze({
    dispatch(options, handler) {
      return agent.dispatch({
        ...options,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      }, handler);
    },
  });
  let disposed = false;

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      void Promise.resolve(agent.destroy()).catch(() => {});
    } catch {
      // Destruction must never hold up the caller's cleanup path.
    }
  }

  return { dispatcher, dispose };
}
