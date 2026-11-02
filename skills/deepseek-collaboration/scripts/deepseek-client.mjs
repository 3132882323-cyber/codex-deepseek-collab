#!/usr/bin/env node
// DeepSeek responses are untrusted text. This client never executes their contents.
import { open, stat, lstat, realpath, writeFile, rename, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 360_000;
const MAX_TOTAL_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 10_000;
const MAX_DIAGNOSTIC_BYTES = 512 * 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const MODEL_ALIASES = ['flash', 'pro'];
const TRUNCATED_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens']);
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const TRANSPORT_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

class SafeError extends Error {
  constructor(code, message, status, metadata) {
    super(message);
    this.code = code;
    if (status !== undefined) this.status = status;
    if (metadata) this.metadata = metadata;
  }
}

function fail(code, message) {
  throw new SafeError(code, message);
}

function parseInteger(value, name, minimum, maximum) {
  if (!/^\d+$/.test(value ?? '')) fail('invalid_argument', `Invalid ${name}.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    fail('invalid_argument', `Invalid ${name}.`);
  }
  return number;
}

function parseArguments(argv) {
  const options = {
    stateDir: resolve(process.env.CODEX_HOME || join(homedir(), '.codex'), 'deepseek-collaboration'),
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    totalTimeoutMs: DEFAULT_TOTAL_TIMEOUT_MS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    retryBaseMs: DEFAULT_RETRY_BASE_MS,
    retryMaxMs: DEFAULT_RETRY_MAX_MS,
    dryRun: false,
    thinking: 'disabled',
  };
  const provided = new Set();
  const values = new Map([
    ['--state-dir', 'stateDir'], ['--prompt-file', 'promptFile'], ['--model', 'model'],
    ['--max-output-tokens', 'maxOutputTokens'], ['--timeout-ms', 'timeoutMs'],
    ['--total-timeout-ms', 'totalTimeoutMs'], ['--max-attempts', 'maxAttempts'],
    ['--retry-base-ms', 'retryBaseMs'], ['--retry-max-ms', 'retryMaxMs'],
    ['--output', 'output'], ['--thinking', 'thinking'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--dry-run') {
      if (provided.has('dryRun')) fail('invalid_argument', 'Duplicate option.');
      options.dryRun = true;
      provided.add('dryRun');
    } else if (values.has(argument)) {
      const name = values.get(argument);
      if (provided.has(name)) fail('invalid_argument', 'Duplicate option.');
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail('invalid_argument', 'An option value is missing.');
      options[name] = value;
      provided.add(name);
      index += 1;
    } else if (!options.action && ['status', 'models', 'ask'].includes(argument)) {
      options.action = argument;
    } else {
      fail('invalid_argument', 'Unknown command or option. Run with --help for usage.');
    }
  }
  if (options.help) return options;
  if (!options.action) fail('invalid_argument', 'A command is required. Run with --help for usage.');
  options.stateDir = resolve(options.stateDir);
  if (options.action !== 'ask') {
    if ([...provided].some(name => name !== 'stateDir')) {
      fail('invalid_argument', 'This command only accepts --state-dir.');
    }
    return options;
  }
  if (!options.promptFile) fail('invalid_argument', 'ask requires --prompt-file.');
  if (options.model && !MODEL_ALIASES.includes(options.model)) {
    fail('invalid_argument', '--model must be flash or pro.');
  }
  if (!['disabled', 'enabled'].includes(options.thinking)) {
    fail('invalid_argument', '--thinking must be disabled or enabled.');
  }
  options.promptFile = resolve(options.promptFile);
  if (options.output) options.output = resolve(options.output);
  options.maxOutputTokens = parseInteger(String(options.maxOutputTokens), '--max-output-tokens', 32, 8192);
  options.timeoutMs = parseInteger(String(options.timeoutMs), '--timeout-ms', 1, MAX_TOTAL_TIMEOUT_MS);
  options.totalTimeoutMs = parseInteger(String(options.totalTimeoutMs), '--total-timeout-ms', 1, MAX_TOTAL_TIMEOUT_MS);
  options.maxAttempts = parseInteger(String(options.maxAttempts), '--max-attempts', 1, 3);
  options.retryBaseMs = parseInteger(String(options.retryBaseMs), '--retry-base-ms', 1, 10_000);
  options.retryMaxMs = parseInteger(String(options.retryMaxMs), '--retry-max-ms', 1, 60_000);
  if (options.retryMaxMs < options.retryBaseMs) {
    fail('invalid_argument', '--retry-max-ms must be at least --retry-base-ms.');
  }
  return options;
}

async function readBoundedFile(path, maximum, kind, optional = false) {
  let handle;
  try {
    handle = await open(path, 'r');
    const details = await handle.stat();
    if (!details.isFile()) fail(`${kind}_invalid`, `The ${kind} must be a regular file.`);
    if (details.size > maximum) fail(`${kind}_too_large`, `The ${kind} exceeds its byte limit.`);
    // Read at most one byte past the limit, even if the file grows after stat().
    const buffer = Buffer.alloc(maximum + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > maximum) fail(`${kind}_too_large`, `The ${kind} exceeds its byte limit.`);
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    if (error instanceof SafeError) throw error;
    if (optional && error?.code === 'ENOENT') return null;
    fail(`${kind}_unavailable`, `The ${kind} could not be read.`);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function decodeUtf8(buffer, kind) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    fail(`${kind}_invalid`, `The ${kind} must contain valid UTF-8 text.`);
  }
}

function validateModel(value) {
  return typeof value === 'string' && /^deepseek[A-Za-z0-9._:-]{1,120}$/i.test(value);
}

async function loadConfig(stateDir, optional = false) {
  const buffer = await readBoundedFile(join(stateDir, 'connection.json'), MAX_CONFIG_BYTES, 'configuration', optional);
  if (buffer === null) return null;
  let raw;
  try {
    raw = JSON.parse(decodeUtf8(buffer, 'configuration'));
  } catch (error) {
    if (error instanceof SafeError) throw error;
    fail('configuration_invalid', 'The configuration is not valid JSON.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.protocol !== 'openai') {
    fail('configuration_invalid', 'The configuration must use the openai protocol.');
  }
  let base;
  try {
    if (typeof raw.base_url !== 'string') throw new Error();
    base = new URL(raw.base_url);
  } catch {
    fail('configuration_invalid', 'The API base URL is invalid.');
  }
  let allowedOrigin;
  try {
    if (typeof raw.allowed_origin !== 'string') throw new Error();
    allowedOrigin = new URL(raw.allowed_origin);
  } catch {
    fail('configuration_invalid', 'The allowed origin is invalid.');
  }
  if (allowedOrigin.protocol !== 'https:' || raw.allowed_origin !== allowedOrigin.origin
      || base.protocol !== 'https:' || base.origin !== allowedOrigin.origin
      || base.username || base.password || base.search || base.hash
      || /[?#]/.test(raw.base_url)) {
    fail('destination_refused', 'The API destination must match the configured HTTPS origin.');
  }
  const credentialSource = raw.credential_source ?? 'dpapi';
  if (!['dpapi', 'env'].includes(credentialSource)) {
    fail('configuration_invalid', 'The credential source must be dpapi or env.');
  }
  if (!validateModel(raw.model) || !raw.models || typeof raw.models !== 'object' || Array.isArray(raw.models)
      || !validateModel(raw.models.flash)
      || (Object.hasOwn(raw.models, 'pro') && !validateModel(raw.models.pro))
      || !MODEL_ALIASES.some(alias => raw.models[alias] === raw.model)) {
    fail('configuration_invalid', 'The configured DeepSeek models are invalid.');
  }
  base.pathname = base.pathname.replace(/\/+$/, '');
  return {
    base_url: base.href.replace(/\/$/, ''),
    allowed_origin: allowedOrigin.origin,
    protocol: 'openai',
    model: raw.model,
    models: { flash: raw.models.flash, ...(raw.models.pro ? { pro: raw.models.pro } : {}) },
    credential_source: credentialSource,
  };
}

async function credentialMetadata(config, stateDir) {
  if (config?.credential_source === 'env') {
    const value = process.env.DEEPSEEK_API_KEY;
    const present = typeof value === 'string' && value.length > 0;
    return { present, valid_size: present && Buffer.byteLength(value, 'utf8') <= 8192
      && /^[\x21-\x7e]+$/.test(value) };
  }
  try {
    const details = await stat(join(stateDir, 'credential.dpapi'));
    return { present: details.isFile(), valid_size: details.isFile() && details.size > 0 && details.size <= MAX_CREDENTIAL_BYTES };
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false, valid_size: false };
    fail('credential_unavailable', 'Credential metadata could not be read.');
  }
}

function validateCredential(credential) {
  if (!credential || credential.length > 8192 || !/^[\x21-\x7e]+$/.test(credential)) {
    fail('credential_invalid', 'The configured credential is invalid.');
  }
  return credential;
}

async function loadCredential(config, stateDir) {
  if (config.credential_source === 'env') {
    const credential = process.env.DEEPSEEK_API_KEY;
    if (!credential) fail('credential_unavailable', 'DEEPSEEK_API_KEY is unavailable.');
    return validateCredential(credential);
  }
  if (process.platform !== 'win32') fail('platform_unsupported', 'Windows DPAPI is required to decrypt this credential.');
  const buffer = await readBoundedFile(join(stateDir, 'credential.dpapi'), MAX_CREDENTIAL_BYTES, 'credential');
  const ciphertext = decodeUtf8(buffer, 'credential').trim();
  if (!ciphertext) fail('credential_invalid', 'The protected credential is empty.');
  // The protected value goes only through stdin. Neither value is included in
  // command arguments, temporary files, PowerShell diagnostics, or client logs.
  const command = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd()) -ErrorAction Stop; [Console]::Out.Write([System.Net.NetworkCredential]::new('', $s).Password)";
  let credential;
  try {
    credential = execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      input: ciphertext,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: MAX_CREDENTIAL_BYTES,
    }).trim();
  } catch {
    fail('credential_decryption_failed', 'The local DPAPI credential could not be decrypted.');
  }
  return validateCredential(credential);
}

function endpoint(config, path) {
  const url = new URL(`${config.base_url}${path}`);
  if (url.protocol !== 'https:' || url.origin !== config.allowed_origin || url.username || url.password
      || url.search || url.hash) {
    fail('destination_refused', 'The API destination must match the configured HTTPS origin.');
  }
  return url;
}

async function readResponseJson(response) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    cancelResponseBody(response);
    fail('response_too_large', 'The API response exceeded its byte limit.');
  }
  if (!response.body) fail('response_invalid', 'The API returned no JSON response body.');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        try { void reader.cancel()?.catch(() => {}); } catch { /* Keep the size error. */ }
        fail('response_too_large', 'The API response exceeded its byte limit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  let data;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
    data = JSON.parse(text);
  } catch {
    fail('response_invalid', 'The API returned invalid or incomplete JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    fail('response_invalid', 'The API returned an invalid JSON response.');
  }
  return data;
}

function cancelResponseBody(response) {
  try { void response?.body?.cancel()?.catch(() => {}); }
  catch { /* The original safe result must not depend on cancellation. */ }
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function elapsedExactMs(startedAt) {
  return Math.max(0, performance.now() - startedAt);
}

function safeRequestId(headers, credential, prompt) {
  for (const name of ['x-request-id', 'request-id', 'x-correlation-id']) {
    const value = headers?.get(name);
    if (typeof value === 'string' && value.length <= 96
        && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
        && !/sk[-_]/i.test(value) && !value.includes(credential)
        && (!prompt || !value.includes(prompt) && !prompt.includes(value))) return value;
  }
  return null;
}

function safeTransportCode(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    try {
      if (typeof current.code === 'string' && TRANSPORT_CODES.has(current.code)) return current.code;
      current = current.cause;
    } catch {
      break;
    }
  }
  return null;
}

function parseRetryAfter(value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const text = value.trim();
  if (/^\d{1,10}$/.test(text)) {
    const seconds = Number(text);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
  }
  if (!/^[\x20-\x7e]+$/.test(text)) return null;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function retryDecision(status, attempt, policy, elapsed, retryAfter) {
  if (!RETRYABLE_STATUSES.has(status) || attempt >= policy.maxAttempts) {
    return { retry: false, reason: 'status' };
  }
  const remaining = policy.totalTimeoutMs - elapsed;
  if (remaining <= 0) return { retry: false, reason: 'budget' };
  const backoffCap = Math.min(policy.retryMaxMs, policy.retryBaseMs * (2 ** (attempt - 1)));
  const backoff = Math.max(1, Math.ceil(backoffCap * (0.5 + Math.random() * 0.5)));
  const retryAfterMs = parseRetryAfter(retryAfter);
  if (retryAfterMs !== null && retryAfterMs > policy.retryMaxMs) {
    return { retry: false, reason: 'cooldown' };
  }
  const delayMs = Math.max(backoff, retryAfterMs ?? 0);
  if (delayMs >= remaining) return { retry: false, reason: 'budget' };
  return { retry: true, delayMs, reason: 'retry' };
}

async function withHardTimeout(work, timeoutMs, onTimeout) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new SafeError('request_timeout', 'The API request timed out; its outcome is unknown.'));
      controller.abort();
      try { onTimeout(); } catch { /* Cancellation must not block the deadline. */ }
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function networkMetadata(startedAt, attempts, status, requestId, history, category, transportCode = null) {
  return {
    attempts,
    elapsed_ms: elapsedMs(startedAt),
    http_status: status,
    error_category: category,
    request_id: requestId,
    attempt_history: history,
    ...(transportCode ? { transport_code: transportCode } : {}),
  };
}

async function request(config, path, credential, body, policy) {
  const startedAt = performance.now();
  const target = endpoint(config, path);
  const headers = { Accept: 'application/json', Authorization: `Bearer ${credential}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const prompt = typeof body?.messages?.[0]?.content === 'string' ? body.messages[0].content : null;
  const history = [];
  let lastStatus = null;
  let lastRequestId = null;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const remaining = policy.totalTimeoutMs - elapsedExactMs(startedAt);
    if (remaining <= 0) {
      throw new SafeError('retry_budget_exhausted', 'The total request time limit was reached.', undefined,
        networkMetadata(startedAt, attempt - 1, lastStatus, lastRequestId, history, 'timeout'));
    }
    lastStatus = null;
    lastRequestId = null;
    const attemptTimeout = Math.max(1, Math.floor(Math.min(policy.timeoutMs, remaining)));
    let response;
    try {
      const data = await withHardTimeout(async signal => {
        // The same approved origin is checked before every request; redirects remain manual.
        response = await fetch(target, {
          method: body === undefined ? 'GET' : 'POST',
          headers,
          body: payload,
          redirect: 'manual',
          signal,
        });
        if (signal.aborted) {
          cancelResponseBody(response);
          throw new SafeError('request_timeout', 'The API request timed out; its outcome is unknown.');
        }
        lastStatus = response.status;
        lastRequestId = safeRequestId(response.headers, credential, prompt);
        if (!response.ok) return null;
        return await readResponseJson(response);
      }, attemptTimeout, () => cancelResponseBody(response));

      if (!response.ok) {
        // Error bodies may echo private inputs. Cancel without reading or awaiting a stuck cancel.
        cancelResponseBody(response);
        const decision = retryDecision(response.status, attempt, policy, elapsedExactMs(startedAt),
          response.headers.get('retry-after'));
        const category = decision.reason === 'cooldown' ? 'cooldown'
          : decision.reason === 'budget' ? 'timeout' : 'http_status';
        history.push({ attempt, status: response.status, category,
          delay_ms: decision.retry ? decision.delayMs : 0, elapsed_ms: elapsedMs(startedAt),
          request_id: lastRequestId });
        if (decision.retry) {
          await new Promise(resolve => setTimeout(resolve, decision.delayMs));
          continue;
        }
        const code = decision.reason === 'cooldown' ? 'retry_cooldown'
          : decision.reason === 'budget' ? 'retry_budget_exhausted' : 'api_http_error';
        const message = decision.reason === 'cooldown'
          ? 'The API requested a cooldown longer than the retry wait limit.'
          : decision.reason === 'budget'
            ? 'The total request time limit cannot fit another retry.'
            : `API HTTP ${response.status}.`;
        throw new SafeError(code, message, response.status);
      }
      history.push({ attempt, status: response.status, category: 'ok', delay_ms: 0,
        elapsed_ms: elapsedMs(startedAt), request_id: lastRequestId });
      return { data, metadata: networkMetadata(startedAt, attempt, response.status, lastRequestId, history, null) };
    } catch (error) {
      const isTimeout = error instanceof SafeError && error.code === 'request_timeout'
        || error?.name === 'AbortError' || error?.name === 'TimeoutError';
      const category = error instanceof SafeError && error.code === 'retry_cooldown' ? 'cooldown'
        : error instanceof SafeError && error.code === 'retry_budget_exhausted' || isTimeout ? 'timeout'
          : error instanceof SafeError && error.code === 'api_http_error' ? 'http_status'
            : error instanceof SafeError ? 'response' : response?.ok ? 'body' : 'transport';
      if (history.at(-1)?.attempt !== attempt) {
        history.push({ attempt, status: lastStatus, category, delay_ms: 0,
          elapsed_ms: elapsedMs(startedAt), request_id: lastRequestId });
      }
      const transportCode = safeTransportCode(error);
      const metadata = networkMetadata(startedAt, attempt, lastStatus, lastRequestId, history,
        category, transportCode);
      if (error instanceof SafeError) {
        error.metadata = metadata;
        throw error;
      }
      throw new SafeError(isTimeout ? 'request_timeout' : 'request_failed',
        isTimeout ? 'The API request timed out; its outcome is unknown.'
          : 'The API request failed; its outcome is unknown.', undefined, metadata);
    }
  }
  // The loop always returns a response or throws a safe error.
  fail('unexpected_failure', 'The request ended unexpectedly.');
}

function redact(value, credential) {
  return typeof value === 'string' ? value.split(credential).join('[REDACTED]') : value;
}

function safeUsage(value, credential, depth = 0) {
  if (depth > 16) return null;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redact(value, credential);
  if (Array.isArray(value)) return value.map(item => safeUsage(item, credential, depth + 1));
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, credential), safeUsage(item, credential, depth + 1)]));
}

function generationResult(data, requestedModel, credential) {
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  const content = choice?.message?.content;
  let answer = '';
  if (typeof content === 'string') answer = content;
  else if (Array.isArray(content)) {
    answer = content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('');
  }
  const finishReason = typeof choice?.finish_reason === 'string' ? redact(choice.finish_reason, credential) : null;
  const truncated = TRUNCATED_REASONS.has(finishReason);
  const result = {
    ok: Boolean(answer.trim()) && finishReason === 'stop' && !truncated,
    model_requested: redact(requestedModel, credential),
    model_reported: typeof data.model === 'string' ? redact(data.model, credential) : null,
    answer: redact(answer, credential),
    usage: data.usage && typeof data.usage === 'object' ? safeUsage(data.usage, credential) : null,
    reasoning_present: typeof choice?.message?.reasoning_content === 'string' && choice.message.reasoning_content.length > 0,
    finish_reason: finishReason,
    truncated,
  };
  if (truncated) {
    result.error_code = 'answer_truncated';
    result.error = 'The answer reached the output limit and is incomplete; no automatic retry was made.';
  } else if (!answer.trim()) {
    result.error_code = 'empty_answer';
    result.error = 'The API returned no usable final message text.';
  } else if (finishReason !== 'stop') {
    result.error_code = 'answer_incomplete';
    result.error = 'The API did not confirm a complete text answer.';
  }
  return result;
}

function samePath(first, second) {
  const normalize = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return normalize(first) === normalize(second);
}

async function assertOutputSafe(options) {
  if (!options.output || options.dryRun) return;
  const protectedPaths = [options.promptFile, join(options.stateDir, 'connection.json'),
    join(options.stateDir, 'credential.dpapi'), join(options.stateDir, 'diagnostics.jsonl'),
    join(options.stateDir, 'diagnostics.previous.jsonl')];
  if (protectedPaths.some(path => samePath(options.output, path))) {
    fail('output_refused', 'The output must not replace a protected input or diagnostic.');
  }
  let outputDetails = null;
  try {
    outputDetails = await lstat(options.output);
    if (!outputDetails.isFile() || outputDetails.isSymbolicLink()) {
      fail('output_refused', 'The output target must be a regular file.');
    }
  } catch (error) {
    if (error instanceof SafeError) throw error;
    if (error?.code !== 'ENOENT') fail('output_unavailable', 'The output target could not be checked.');
  }
  let resolvedOutput;
  try {
    resolvedOutput = join(await realpath(dirname(options.output)), basename(options.output));
  } catch {
    fail('output_unavailable', 'The output directory is unavailable.');
  }
  for (const path of protectedPaths) {
    let protectedRealPath;
    try { protectedRealPath = await realpath(path); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      fail('output_unavailable', 'A protected input path could not be checked.');
    }
    if (samePath(resolvedOutput, protectedRealPath)) {
      fail('output_refused', 'The output must not replace a protected input or diagnostic.');
    }
    if (outputDetails?.ino) {
      let protectedDetails;
      try { protectedDetails = await stat(path); }
      catch { fail('output_unavailable', 'A protected input path could not be checked.'); }
      if (outputDetails.dev === protectedDetails.dev && outputDetails.ino === protectedDetails.ino) {
        fail('output_refused', 'The output must not replace a protected input or diagnostic.');
      }
    }
  }
}

async function emitResult(result, options, stream = process.stdout) {
  let finalResult = result;
  if (options?.output && !options.dryRun) {
    const temporary = join(dirname(options.output), `.${basename(options.output)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, options.output);
    } catch {
      finalResult = { ...result, ok: false,
        output_error: `The result file could not be written; the result is available in ${stream === process.stderr ? 'stderr' : 'stdout'}.` };
      process.exitCode = 1;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  stream.write(`${JSON.stringify(finalResult, null, 2)}\n`);
  if (!finalResult.ok && !process.exitCode) process.exitCode = finalResult.truncated ? 2 : 1;
}

function errorResult(error) {
  return error instanceof SafeError
    ? { ok: false, error_code: error.code, error: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.metadata ?? {}) }
    : { ok: false, error_code: 'unexpected_failure',
      error: 'The client failed; unsafe diagnostic details were suppressed.' };
}

async function optionalRegularFile(path) {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error('Unsafe diagnostic target.');
    return details;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function aliasesPromptFile(promptPath, targetPath) {
  if (!promptPath) return false;
  if (samePath(promptPath, targetPath)) return true;
  let target;
  try { target = await stat(targetPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const prompt = await stat(promptPath);
  if (prompt.ino && prompt.dev === target.dev && prompt.ino === target.ino) return true;
  return samePath(await realpath(promptPath), await realpath(targetPath));
}

function diagnosticRequestId(value) {
  return typeof value === 'string'
    ? `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}` : null;
}

function diagnosticRequestFingerprint(raw, fingerprint) {
  // The agent runtime supplies only its own fingerprint through this field.
  if (typeof raw === 'string') return diagnosticRequestId(raw);
  return typeof fingerprint === 'string' && /^sha256:[0-9a-f]{16}$/.test(fingerprint)
    ? fingerprint : null;
}

async function recordDiagnostic(stateDir, action, model, result, promptPath) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    model,
    ok: result.ok === true,
    attempts: Number.isInteger(result.attempts) ? result.attempts : 0,
    elapsed_ms: Number.isFinite(result.elapsed_ms) ? result.elapsed_ms : 0,
    http_status: Number.isInteger(result.http_status) ? result.http_status : null,
    error_code: result.error_code ?? null,
    error_category: result.error_category ?? null,
    transport_code: result.transport_code ?? null,
    request_id: diagnosticRequestFingerprint(result.request_id, result.request_id_hash),
    attempt_history: Array.isArray(result.attempt_history) ? result.attempt_history.map(item => ({
      attempt: item.attempt, status: item.status, category: item.category,
      delay_ms: item.delay_ms, elapsed_ms: item.elapsed_ms,
      request_id: diagnosticRequestFingerprint(item.request_id, item.request_id_hash),
    })) : [],
  };
  const line = `${JSON.stringify(entry)}\n`;
  const currentPath = join(stateDir, 'diagnostics.jsonl');
  const previousPath = join(stateDir, 'diagnostics.previous.jsonl');
  let handle;
  try {
    if (await aliasesPromptFile(promptPath, currentPath)
        || await aliasesPromptFile(promptPath, previousPath)) return false;
    const current = await optionalRegularFile(currentPath);
    if (current && current.size + Buffer.byteLength(line) > MAX_DIAGNOSTIC_BYTES) {
      if (await optionalRegularFile(previousPath)) await unlink(previousPath);
      await rename(currentPath, previousPath);
    }
    handle = await open(currentPath, 'a', 0o600);
    await handle.chmod(0o600);
    await handle.appendFile(line, { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function executeNetwork(options, action, model, config, path, credential, body, policy, transform) {
  let result;
  let requestMetadata = null;
  let failedByException = false;
  try {
    const response = await request(config, path, credential, body, policy);
    requestMetadata = response.metadata;
    result = { ...transform(response.data), ...requestMetadata };
    if (!result.ok) {
      result.error_category = result.error_code === 'answer_truncated' ? 'answer_truncated' : 'answer';
    }
  } catch (error) {
    failedByException = true;
    if (requestMetadata && error instanceof SafeError && !error.metadata) {
      error.metadata = { ...requestMetadata, error_category: 'response' };
    }
    result = errorResult(error);
    if (requestMetadata && !(error instanceof SafeError)) {
      result = { ...result, ...requestMetadata, error_category: 'response' };
    }
  }
  result.diagnostic_recorded = await recordDiagnostic(options.stateDir, action,
    redact(model, credential), result, options.promptFile);
  if (failedByException) {
    await emitResult(result, options, process.stderr);
    return;
  }
  await emitResult(result, options);
}

let safeOutputOptions = null;

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage:\n  deepseek-client.mjs [--state-dir PATH] status\n  deepseek-client.mjs [--state-dir PATH] models\n  deepseek-client.mjs [--state-dir PATH] ask --prompt-file PATH [--model flash|pro] [--thinking disabled|enabled] [--max-output-tokens 32..8192] [--timeout-ms N] [--total-timeout-ms N] [--max-attempts 1..3] [--retry-base-ms 1..10000] [--retry-max-ms 1..60000] [--output PATH] [--dry-run]\n\nask defaults: thinking disabled, 4096 generated tokens, 180000 ms per attempt, 360000 ms total, 3 attempts, 1000..10000 ms bounded retry wait, 128 KiB maximum UTF-8 input.\nOnly explicit HTTP 429/500/502/503/504 responses are retryable. A POST timeout or transport failure is never replayed.\nstatus and --dry-run never decrypt credentials or use the network.\n--dry-run only prints metadata and never writes an --output target.\n');
    return;
  }
  if (options.action === 'ask' && options.output && !options.dryRun) {
    await assertOutputSafe(options);
    safeOutputOptions = options;
  }
  const config = await loadConfig(options.stateDir, options.action === 'status');
  if (options.action === 'status') {
    const credential = await credentialMetadata(config, options.stateDir);
    await emitResult({
      ok: true,
      state_dir: options.stateDir,
      configured: Boolean(config) && credential.valid_size,
      credential_present: credential.present,
      credential_size_valid: credential.valid_size,
      credential_storage: config?.credential_source === 'env'
        ? 'Environment variable DEEPSEEK_API_KEY' : 'Windows DPAPI',
      credential_source: config?.credential_source ?? 'dpapi',
      base_url: config?.base_url ?? null,
      allowed_origin: config?.allowed_origin ?? null,
      protocol: config?.protocol ?? null,
      model: config?.model ?? null,
      models: config?.models ?? null,
      network_used: false,
      credential_decrypted: false,
    }, options);
    return;
  }
  if (options.action === 'models') {
    const credential = await loadCredential(config, options.stateDir);
    await executeNetwork(options, 'models', config.model, config, '/models', credential, undefined,
      { timeoutMs: DEFAULT_TIMEOUT_MS, totalTimeoutMs: DEFAULT_TIMEOUT_MS, maxAttempts: 1,
        retryBaseMs: DEFAULT_RETRY_BASE_MS, retryMaxMs: DEFAULT_RETRY_MAX_MS }, data => {
        const source = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : null;
        if (!source) fail('response_invalid', 'The API returned no model list.');
        const models = [...new Set(source.map(item => typeof item === 'string' ? item : item?.id)
          .filter(id => typeof id === 'string').map(id => redact(id, credential)))];
        return { ok: true, model_count: models.length, models,
          deepseek_models: models.filter(id => /deepseek/i.test(id)),
          configured_models: Object.fromEntries(Object.entries(config.models)
            .map(([alias, id]) => [alias, redact(id, credential)])),
          configured_model_present: models.includes(config.model) };
      });
    return;
  }
  const buffer = await readBoundedFile(options.promptFile, MAX_PROMPT_BYTES, 'prompt');
  const prompt = decodeUtf8(buffer, 'prompt');
  if (!prompt.trim()) fail('prompt_empty', 'The prompt must contain text.');
  const model = options.model ? config.models[options.model] : config.model;
  if (!model) fail('model_unavailable', 'The requested model alias is not configured.');
  if (options.dryRun) {
    await emitResult({
      ok: true,
      dry_run: true,
      model_requested: model,
      prompt_bytes: buffer.byteLength,
      max_prompt_bytes: MAX_PROMPT_BYTES,
      max_output_tokens: options.maxOutputTokens,
      thinking: options.thinking,
      timeout_ms: options.timeoutMs,
      total_timeout_ms: options.totalTimeoutMs,
      max_attempts: options.maxAttempts,
      retry_base_ms: options.retryBaseMs,
      retry_max_ms: options.retryMaxMs,
      automatic_retries: options.maxAttempts - 1,
      network_used: false,
      credential_decrypted: false,
    }, options);
    return;
  }
  const credential = await loadCredential(config, options.stateDir);
  await executeNetwork(options, 'ask', model, config, '/chat/completions', credential, {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: options.maxOutputTokens,
    thinking: { type: options.thinking },
    stream: false,
  }, options, data => generationResult(data, model, credential));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(async error => {
    // Never print native exceptions, subprocess stderr, response bodies, or stacks.
    const result = errorResult(error);
    if (safeOutputOptions) await emitResult(result, safeOutputOptions, process.stderr);
    else {
      process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 1;
    }
  });
}

export { SafeError, loadConfig, loadCredential, request, recordDiagnostic, safeTransportCode };
