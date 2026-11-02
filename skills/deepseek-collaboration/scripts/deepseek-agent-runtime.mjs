// A bounded, in-memory DeepSeek tool loop. Model-visible files live only in a
// fresh scratch directory; Codex plugin calls are handed back to the host.
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadConfig, loadCredential, request, recordDiagnostic, safeTransportCode } from './deepseek-client.mjs';

const KiB = 1024;
const TASK_LIMIT = 128 * KiB;
const FILE_LIMIT = 64 * KiB;
const FILES_LIMIT = 128 * KiB;
const HISTORY_LIMIT = 256 * KiB;
const TOOL_RESULT_LIMIT = 64 * KiB;
const PLUGIN_TOOLS_LIMIT = 64 * KiB;
const MAX_TASKS = 16;
const MAX_FILES = 128;
const LOCAL_NAMES = new Set(['list_files', 'read_file', 'write_file']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const NETWORK_CATEGORIES = new Set(['timeout', 'cooldown', 'http_status', 'response', 'body', 'transport', 'ok']);
const SAFE_ERROR_CODES = new Set([
  'invalid_argument', 'invalid_state', 'task_not_found', 'runtime_disposed',
  'task_limit', 'deadline_exceeded', 'step_limit', 'tool_limit',
  'http_attempt_limit', 'context_too_large', 'model_unavailable',
  'model_response_invalid', 'answer_incomplete', 'answer_truncated',
  'tool_call_invalid', 'tool_result_invalid', 'path_refused', 'file_unavailable',
  'file_too_large', 'file_limit', 'scratch_unavailable', 'runtime_failed',
  'configuration_invalid', 'configuration_unavailable', 'credential_unavailable',
  'credential_invalid', 'credential_decryption_failed', 'destination_refused',
  'platform_unsupported', 'api_http_error', 'retry_cooldown',
  'retry_budget_exhausted', 'request_timeout', 'request_failed',
  'response_too_large', 'response_invalid',
]);

export class AgentRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentRuntimeError';
    this.code = code;
  }
}

function fail(code, message) { throw new AgentRuntimeError(code, message); }
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function bytes(value) { return Buffer.byteLength(value, 'utf8'); }
function boundedInteger(value, name, fallback, low, high) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < low || value > high) {
    fail('invalid_argument', `Invalid ${name}.`);
  }
  return value;
}
function hash(content) { return createHash('sha256').update(content, 'utf8').digest('hex'); }
function redactKnown(value, credential, depth = 0) {
  if (depth > 32) fail('model_response_invalid', 'The model response is too deeply nested.');
  if (typeof value === 'string') return value.split(credential).join('[REDACTED]');
  if (Array.isArray(value)) return value.map(item => redactKnown(item, credential, depth + 1));
  if (plain(value)) return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key.split(credential).join('[REDACTED]'),
      redactKnown(item, credential, depth + 1)]));
  return value;
}
function containsKnown(value, credential, depth = 0) {
  if (depth > 32) fail('model_response_invalid', 'The model response is too deeply nested.');
  if (typeof value === 'string') return value.includes(credential);
  if (Array.isArray(value)) return value.some(item => containsKnown(item, credential, depth + 1));
  if (plain(value)) return Object.entries(value).some(([key, item]) =>
    key.includes(credential) || containsKnown(item, credential, depth + 1));
  return false;
}
function safeJson(value, limit, code = 'invalid_argument') {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail(code, 'The JSON value is invalid.'); }
  if (typeof encoded !== 'string' || bytes(encoded) > limit) {
    fail(code, 'The JSON value exceeds its byte limit.');
  }
  return encoded;
}
function within(root, target) {
  const rel = relative(root, target);
  return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function validatePath(path, allowDot = false) {
  if (allowDot && path === '.') return [];
  if (typeof path !== 'string' || !path || bytes(path) > 512 || path.includes('\\')
      || path.startsWith('/') || /^[A-Za-z]:/.test(path) || /[\x00-\x1f:\x7f]/.test(path)) {
    fail('path_refused', 'Only a relative scratch path is allowed.');
  }
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)
      || /(?:^|[._-])(?:secret|secrets|credential|credentials|password|passwd|token|api[_-]?key|private[_-]?key)(?:$|[._-])/i.test(part)
      || /^(?:\.env(?:\..*)?|\.git|\.ssh|\.npmrc|\.netrc|id_rsa|id_ed25519)$/i.test(part)
      || /\.(?:pem|p12|pfx|key)$/i.test(part))) {
    fail('path_refused', 'The scratch path is not allowed.');
  }
  return parts;
}
function pathFor(record, parts) {
  const target = resolve(record.scratchDir, ...parts);
  if (!within(record.scratchDir, target)) fail('path_refused', 'The scratch path is not allowed.');
  return target;
}
async function safeStat(path, optional = false) {
  try { return await lstat(path); }
  catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    fail('file_unavailable', 'A scratch file could not be inspected.');
  }
}
async function checkedDirectory(record, parts, create = false) {
  let current = record.scratchDir;
  for (const part of parts) {
    if (create && record.cancelled) fail('invalid_state', 'The task was cancelled.');
    current = join(current, part);
    let details = await safeStat(current, true);
    if (!details && create) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (error?.code !== 'EEXIST') fail('scratch_unavailable', 'The scratch directory could not be created.'); }
      details = await safeStat(current);
    }
    if (!details || !details.isDirectory() || details.isSymbolicLink()) {
      fail('path_refused', 'The scratch path contains an unsafe directory.');
    }
    const actual = await realpath(current).catch(() => fail('path_refused', 'The scratch directory could not be resolved.'));
    if (!within(record.scratchDir, actual)) fail('path_refused', 'The scratch path escapes its directory.');
  }
  return current;
}
async function checkedFile(record, parts, optional = false) {
  await checkedDirectory(record, parts.slice(0, -1));
  const target = pathFor(record, parts);
  const details = await safeStat(target, optional);
  if (!details) return null;
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
    fail('path_refused', 'The scratch path is not a private regular file.');
  }
  const actual = await realpath(target).catch(() => fail('path_refused', 'The scratch file could not be resolved.'));
  if (!within(record.scratchDir, actual)) fail('path_refused', 'The scratch path escapes its directory.');
  return details;
}
async function allFiles(record) {
  const found = [];
  const walk = async (parts) => {
    const dir = pathFor(record, parts);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => fail('file_unavailable', 'The scratch directory could not be listed.'));
    for (const entry of entries) {
      const next = [...parts, entry.name];
      validatePath(next.join('/'));
      const target = pathFor(record, next);
      const details = await safeStat(target);
      if (details.isSymbolicLink()) fail('path_refused', 'A scratch symlink is not allowed.');
      if (details.isDirectory()) {
        await checkedDirectory(record, next);
        await walk(next);
      } else if (details.isFile() && details.nlink === 1) {
        found.push({ path: next.join('/'), size: details.size });
        if (found.length > MAX_FILES) fail('file_limit', 'The scratch directory has too many files.');
      } else fail('path_refused', 'An unsafe scratch entry was found.');
    }
  };
  await walk([]);
  found.sort((a, b) => a.path.localeCompare(b.path));
  return found;
}
async function readText(record, path) {
  const parts = validatePath(path);
  const details = await checkedFile(record, parts);
  if (details.size > FILE_LIMIT) fail('file_too_large', 'The scratch file exceeds its byte limit.');
  const target = pathFor(record, parts);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > FILE_LIMIT
        || opened.ino !== details.ino || opened.dev !== details.dev) {
      fail('path_refused', 'The scratch file changed during the read.');
    }
    const data = await handle.readFile();
    if (data.byteLength > FILE_LIMIT) fail('file_too_large', 'The scratch file exceeds its byte limit.');
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch (error) {
    if (error instanceof AgentRuntimeError) throw error;
    fail('file_unavailable', 'The scratch file could not be read as UTF-8.');
  } finally { if (handle) await handle.close().catch(() => {}); }
}
async function writeText(record, path, content) {
  if (record.cancelled) fail('invalid_state', 'The task was cancelled.');
  const parts = validatePath(path);
  if (typeof content !== 'string') fail('tool_call_invalid', 'File content must be text.');
  const size = bytes(content);
  if (size > FILE_LIMIT) fail('file_too_large', 'A scratch file exceeds its byte limit.');
  await checkedDirectory(record, parts.slice(0, -1), true);
  const previous = await checkedFile(record, parts, true);
  const files = await allFiles(record);
  const used = files.reduce((sum, file) => sum + file.size, 0);
  if (used - (previous?.size ?? 0) + size > FILES_LIMIT
      || !previous && files.length >= MAX_FILES) {
    fail('file_limit', 'The scratch file budget is exhausted.');
  }
  const target = pathFor(record, parts);
  const temporary = join(record.scratchDir, `.agent-tmp-${randomUUID()}`);
  let handle;
  try {
    if (record.cancelled) fail('invalid_state', 'The task was cancelled.');
    handle = await open(temporary, 'wx', 0o600);
    if (record.cancelled) fail('invalid_state', 'The task was cancelled.');
    await handle.writeFile(content, 'utf8');
    await handle.close();
    handle = null;
    await checkedDirectory(record, parts.slice(0, -1));
    await checkedFile(record, parts, true);
    if (record.cancelled) fail('invalid_state', 'The task was cancelled.');
    await rename(temporary, target);
    await checkedFile(record, parts);
  } catch (error) {
    if (error instanceof AgentRuntimeError) throw error;
    fail('file_unavailable', 'The scratch file could not be written.');
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
  return { path, bytes: size, sha256: hash(content) };
}

const LOCAL_TOOLS = [
  { type: 'function', function: { name: 'list_files', description: 'List relative files in the isolated scratch directory.', parameters: {
    type: 'object', properties: { path: { type: 'string', description: 'Optional relative directory; use . for the root.' } }, additionalProperties: false,
  } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 file in the isolated scratch directory.', parameters: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
  } } },
  { type: 'function', function: { name: 'write_file', description: 'Write a UTF-8 artifact file in the isolated scratch directory.', parameters: {
    type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'], additionalProperties: false,
  } } },
];
function toolSpecs(pluginTools) {
  const specs = [...LOCAL_TOOLS];
  if (pluginTools.length) specs.push({ type: 'function', function: {
    name: 'codex_tool', description: 'Request an allowlisted Codex host tool; the host executes it and returns its result. Allowed tools, descriptions, and input schemas: '
      + JSON.stringify(pluginTools.map(tool => ({ name: tool.name, description: tool.description,
        input_schema: tool.input_schema ?? { type: 'object' } }))),
    parameters: { type: 'object', oneOf: pluginTools.map(tool => ({
      type: 'object',
      properties: {
        name: { type: 'string', enum: [tool.name], description: tool.description },
        arguments: tool.input_schema ?? { type: 'object' },
      },
      required: ['name', 'arguments'], additionalProperties: false,
    })) },
  } });
  return specs;
}
function validateStart(args) {
  if (!plain(args) || typeof args.task !== 'string' || !args.task.trim() || bytes(args.task) > TASK_LIMIT
      || !['flash', 'pro'].includes(args.model)) fail('invalid_argument', 'A bounded task and model alias are required.');
  const maxSteps = boundedInteger(args.max_steps, 'max_steps', 6, 1, 12);
  const maxToolCalls = boundedInteger(args.max_tool_calls, 'max_tool_calls', 12, 1, 32);
  const totalTimeoutMs = boundedInteger(args.total_timeout_ms, 'total_timeout_ms', 360_000, 1, 900_000);
  const maxOutputTokens = boundedInteger(args.max_output_tokens, 'max_output_tokens', 4096, 32, 8192);
  const files = args.files ?? [];
  if (!Array.isArray(files) || files.length > MAX_FILES) fail('invalid_argument', 'Invalid input files.');
  const seenFiles = new Set();
  let fileBytes = 0;
  for (const file of files) {
    if (!plain(file) || typeof file.content !== 'string') fail('invalid_argument', 'Invalid input file.');
    validatePath(file.path);
    const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
    if (seenFiles.has(key)) fail('invalid_argument', 'Duplicate input file.');
    seenFiles.add(key);
    fileBytes += bytes(file.content);
    if (bytes(file.content) > FILE_LIMIT || fileBytes > FILES_LIMIT) fail('file_limit', 'Input files exceed their byte limit.');
  }
  const pluginTools = args.plugin_tools ?? [];
  if (!Array.isArray(pluginTools) || pluginTools.length > 32) fail('invalid_argument', 'Invalid plugin tool allowlist.');
  const seenTools = new Set();
  for (const tool of pluginTools) {
    if (!plain(tool) || typeof tool.name !== 'string'
        || !/^[A-Za-z][A-Za-z0-9_.:-]{0,511}$/.test(tool.name)
        || LOCAL_NAMES.has(tool.name) || tool.name === 'codex_tool'
        || seenTools.has(tool.name) || typeof tool.description !== 'string'
        || bytes(tool.description) > 2048
        || tool.input_schema !== undefined && !plain(tool.input_schema)) {
      fail('invalid_argument', 'Invalid plugin tool allowlist.');
    }
    seenTools.add(tool.name);
  }
  safeJson(pluginTools, PLUGIN_TOOLS_LIMIT);
  return { task: args.task, model: args.model, files, pluginTools, maxSteps, maxToolCalls,
    totalTimeoutMs, maxOutputTokens };
}
function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).every(key => keys.includes(key))
    && keys.every(key => Object.hasOwn(value, key));
}
function validateToolCalls(record, rawCalls) {
  if (!Array.isArray(rawCalls) || !rawCalls.length || rawCalls.length > 32) {
    fail('tool_call_invalid', 'The model returned an invalid tool batch.');
  }
  if (record.toolCalls + rawCalls.length > record.maxToolCalls) fail('tool_limit', 'The tool call limit was reached.');
  const ids = new Set();
  const calls = [];
  for (const raw of rawCalls) {
    if (!plain(raw) || typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.id)
        || ids.has(raw.id) || record.seenCallIds.has(raw.id) || raw.type !== 'function'
        || !plain(raw.function) || typeof raw.function.name !== 'string'
        || typeof raw.function.arguments !== 'string' || bytes(raw.function.arguments) > TOOL_RESULT_LIMIT) {
      fail('tool_call_invalid', 'The model returned an invalid tool call.');
    }
    ids.add(raw.id);
    let args;
    try { args = redactKnown(JSON.parse(raw.function.arguments), record.credential); }
    catch { fail('tool_call_invalid', 'Tool arguments are not valid JSON.'); }
    const name = raw.function.name;
    if (name === 'list_files') {
      if (!plain(args) || Object.keys(args).some(key => key !== 'path')
          || args.path !== undefined && typeof args.path !== 'string') {
        fail('tool_call_invalid', 'Invalid list_files arguments.');
      }
      validatePath(args.path ?? '.', true);
    } else if (name === 'read_file') {
      if (!exactKeys(args, ['path'])) fail('tool_call_invalid', 'Invalid read_file arguments.');
      validatePath(args.path);
    } else if (name === 'write_file') {
      if (!exactKeys(args, ['path', 'content']) || typeof args.content !== 'string') {
        fail('tool_call_invalid', 'Invalid write_file arguments.');
      }
      validatePath(args.path);
      if (bytes(args.content) > FILE_LIMIT) fail('file_too_large', 'A scratch file exceeds its byte limit.');
    } else if (name === 'codex_tool') {
      if (!exactKeys(args, ['name', 'arguments']) || !record.pluginToolNames.has(args.name)
          || !plain(args.arguments)) fail('tool_call_invalid', 'The host tool is not allowlisted.');
      safeJson(args.arguments, TOOL_RESULT_LIMIT, 'tool_call_invalid');
    } else fail('tool_call_invalid', 'The model selected an unknown tool.');
    calls.push({ id: raw.id, name, args, raw });
  }
  return calls;
}
function safeFailure(error) {
  const code = typeof error?.code === 'string' && SAFE_ERROR_CODES.has(error.code)
    ? error.code : 'runtime_failed';
  const messages = {
    runtime_failed: 'The agent run failed; unsafe details were suppressed.',
    model_response_invalid: 'The model returned an invalid response.',
    answer_incomplete: 'The model did not return a complete final answer.',
    answer_truncated: 'The model reached its output limit.',
    deadline_exceeded: 'The agent time limit was reached.',
    step_limit: 'The model step limit was reached.',
    tool_limit: 'The tool call limit was reached.',
    context_too_large: 'The conversation exceeds its byte limit.',
    request_timeout: 'The API request timed out; its outcome is unknown.',
    request_failed: 'The API request failed; its outcome is unknown.',
  };
  return { code, message: error instanceof AgentRuntimeError ? error.message
    : messages[code] ?? 'The agent run failed; unsafe details were suppressed.' };
}
function ownValue(value, key) {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}
function safeCount(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
function stepErrorCode(error) {
  const code = ownValue(error, 'code');
  return typeof code === 'string' && SAFE_ERROR_CODES.has(code) ? code : 'runtime_failed';
}
function fallbackCategory(errorCode) {
  if (errorCode === 'request_timeout' || errorCode === 'retry_budget_exhausted') return 'timeout';
  if (errorCode === 'retry_cooldown') return 'cooldown';
  if (errorCode === 'api_http_error') return 'http_status';
  if (errorCode === 'response_invalid' || errorCode === 'response_too_large') return 'response';
  if (errorCode === 'request_failed') return 'transport';
  return null;
}
function safeRequestFingerprint(value, credential) {
  if (typeof value !== 'string' || value.length > 96
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
      || /sk[-_]/i.test(value) || value.includes(credential)) return null;
  return `sha256:${hash(value).slice(0, 16)}`;
}
function safeStepMetadata(raw, errorCode, startedAt, credential) {
  const attemptsValue = ownValue(raw, 'attempts');
  const statusValue = ownValue(raw, 'http_status');
  const categoryValue = ownValue(raw, 'error_category');
  const transportCode = safeTransportCode({ code: ownValue(raw, 'transport_code') });
  const historyValue = ownValue(raw, 'attempt_history');
  const attemptHistory = Array.isArray(historyValue) ? historyValue.slice(0, 3).flatMap(item => {
    const attempt = ownValue(item, 'attempt');
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 3) return [];
    const status = ownValue(item, 'status');
    const category = ownValue(item, 'category');
    return [{ attempt,
      status: Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null,
      category: NETWORK_CATEGORIES.has(category) ? category : null,
      delay_ms: safeCount(ownValue(item, 'delay_ms'), 0),
      elapsed_ms: safeCount(ownValue(item, 'elapsed_ms'), 0),
      request_id_hash: safeRequestFingerprint(ownValue(item, 'request_id'), credential) }];
  }) : [];
  return {
    attempts: Number.isSafeInteger(attemptsValue) && attemptsValue >= 0 && attemptsValue <= 3
      ? attemptsValue : 1,
    elapsed_ms: safeCount(ownValue(raw, 'elapsed_ms'), Math.max(0, Date.now() - startedAt)),
    http_status: Number.isSafeInteger(statusValue) && statusValue >= 100 && statusValue <= 599
      ? statusValue : null,
    error_category: NETWORK_CATEGORIES.has(categoryValue) && categoryValue !== 'ok'
      ? categoryValue : fallbackCategory(errorCode),
    ...(transportCode ? { transport_code: transportCode } : {}),
    request_id_hash: safeRequestFingerprint(ownValue(raw, 'request_id'), credential),
    attempt_history: attemptHistory,
  };
}
function publicNetwork(metadata) {
  return { attempts: metadata.attempts, elapsed_ms: metadata.elapsed_ms,
    http_status: metadata.http_status, error_category: metadata.error_category,
    ...(metadata.transport_code ? { transport_code: metadata.transport_code } : {}) };
}
function elapsed(record) { return Math.max(0, Date.now() - record.startedAt); }
function metadata(record) {
  return { state: record.state, task_id: record.id, model: record.modelAlias,
    steps: record.steps, tool_calls: record.toolCalls, http_attempts: record.httpAttempts,
    elapsed_ms: elapsed(record) };
}
function view(record) {
  const base = metadata(record);
  if (record.state === 'waiting_for_tools') return { ...base,
    requests: record.pending.requests.map(item => ({ ...item })), artifacts: record.artifacts ?? [] };
  if (record.state === 'completed') return { ...base, answer: record.answer, artifacts: record.artifacts };
  if (record.state === 'failed') return { ...base, error_code: record.errorCode, error: record.error,
    ...(record.network ? { network: record.network } : {}) };
  return base;
}
function markFailed(record, error) {
  const safe = safeFailure(error);
  record.state = 'failed';
  record.errorCode = safe.code;
  record.error = safe.message;
  record.messages = null;
  record.pending = null;
  record.credential = null;
  return view(record);
}
function expired(record) { return Date.now() >= record.deadlineAt; }
function checkActive(record) {
  if (record.cancelled) { record.state = 'cancelled'; return false; }
  if (expired(record)) { markFailed(record, new AgentRuntimeError('deadline_exceeded', 'The agent time limit was reached.')); return false; }
  return true;
}
function ensureHistory(record) {
  if (bytes(safeJson(record.messages, HISTORY_LIMIT, 'context_too_large')) > HISTORY_LIMIT) {
    fail('context_too_large', 'The conversation exceeds its byte limit.');
  }
}
async function localTool(record, call) {
  let result;
  if (call.name === 'list_files') {
    const parts = validatePath(call.args.path ?? '.', true);
    await checkedDirectory(record, parts);
    const prefix = parts.length ? `${parts.join('/')}/` : '';
    result = { files: (await allFiles(record)).map(item => item.path).filter(path => path.startsWith(prefix)) };
  } else if (call.name === 'read_file') {
    result = { path: call.args.path, content: await readText(record, call.args.path) };
  } else {
    result = await writeText(record, call.args.path, call.args.content);
  }
  return safeJson(result, TOOL_RESULT_LIMIT, 'tool_result_invalid');
}
async function collectArtifacts(record) {
  const artifacts = [];
  const files = await allFiles(record);
  if (files.reduce((sum, file) => sum + file.size, 0) > FILES_LIMIT) {
    fail('file_limit', 'The scratch file budget is exhausted.');
  }
  for (const file of files) {
    const content = await readText(record, file.path);
    const digest = hash(content);
    if (record.baseline.get(file.path) !== digest) {
      artifacts.push({ path: file.path, content, sha256: digest });
    }
  }
  return artifacts;
}
function assistantMessage(message) {
  return { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls };
}
function toolMessage(id, content) { return { role: 'tool', tool_call_id: id, content }; }

export function createAgentRuntime(options = {}) {
  if (!plain(options)) fail('invalid_argument', 'Invalid runtime options.');
  const stateDir = resolve(options.stateDir ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'deepseek-collaboration'));
  const scratchRoot = resolve(options.scratchRoot ?? join(stateDir, 'scratch'));
  const readConfig = options.loadConfig ?? loadConfig;
  const readCredential = options.loadCredential ?? loadCredential;
  const sendRequest = options.request ?? request;
  const writeDiagnostic = options.recordDiagnostic
    ?? (typeof options.request === 'function' ? async () => false : recordDiagnostic);
  if (![readConfig, readCredential, sendRequest, writeDiagnostic].every(value => typeof value === 'function')) {
    fail('invalid_argument', 'Invalid runtime dependencies.');
  }
  async function recordStep(record, ok, rawMetadata, error, startedAt) {
    const errorCode = ok ? null : stepErrorCode(error);
    let metadata;
    try { metadata = safeStepMetadata(rawMetadata, errorCode, startedAt, record.credential); }
    catch { metadata = safeStepMetadata(null, errorCode, startedAt, record.credential); }
    try {
      await writeDiagnostic(stateDir, 'agent_step', record.modelAlias,
        { ok, ...metadata, error_code: errorCode });
    } catch { /* Diagnostic failures cannot change the HTTP step outcome. */ }
    return metadata;
  }
  const records = new Map();
  let disposed = false;
  function bindSignal(record, control) {
    if (control === undefined) return () => {};
    if (!plain(control) || control.signal !== undefined
        && (typeof control.signal?.aborted !== 'boolean'
          || typeof control.signal.addEventListener !== 'function'
          || typeof control.signal.removeEventListener !== 'function')) {
      fail('invalid_argument', 'Invalid abort control.');
    }
    const signal = control.signal;
    if (!signal) return () => {};
    const abort = () => {
      if (TERMINAL.has(record.state)) return;
      record.cancelled = true;
      record.state = record.busy ? 'cancelling' : 'cancelled';
      if (!record.busy) { record.pending = null; record.messages = null; record.credential = null; }
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return () => signal.removeEventListener('abort', abort);
  }
  const alive = () => { if (disposed) fail('runtime_disposed', 'The runtime has been disposed.'); };
  const find = taskId => {
    if (typeof taskId !== 'string' || !/^[0-9a-f-]{36}$/i.test(taskId) || !records.has(taskId)) {
      fail('task_not_found', 'The agent task was not found.');
    }
    return records.get(taskId);
  };

  async function drive(record) {
    record.busy = true;
    try {
      while (true) {
        if (!checkActive(record)) return view(record);
        if (record.steps >= record.maxSteps) fail('step_limit', 'The model step limit was reached.');
        if (record.httpAttempts >= record.maxHttpAttempts) fail('http_attempt_limit', 'The HTTP attempt limit was reached.');
        ensureHistory(record);
        const remaining = record.deadlineAt - Date.now();
        const policy = { timeoutMs: Math.max(1, Math.min(180_000, remaining)),
          totalTimeoutMs: Math.max(1, remaining),
          maxAttempts: Math.min(3, record.maxHttpAttempts - record.httpAttempts),
          retryBaseMs: 1000, retryMaxMs: 10_000 };
        const body = { model: record.modelId, messages: record.messages, tools: record.tools,
          tool_choice: 'auto', max_tokens: record.maxOutputTokens,
          thinking: { type: 'disabled' }, stream: false };
        record.steps += 1;
        const stepStartedAt = Date.now();
        let response;
        try { response = await sendRequest(record.config, '/chat/completions', record.credential, body, policy); }
        catch (error) {
          const stepMetadata = await recordStep(record, false, ownValue(error, 'metadata'), error, stepStartedAt);
          record.network = publicNetwork(stepMetadata);
          record.httpAttempts += Math.max(1, Math.min(policy.maxAttempts,
            stepMetadata.attempts));
          if (record.cancelled) { record.state = 'cancelled'; return view(record); }
          throw error;
        }
        const stepMetadata = await recordStep(record, true, ownValue(response, 'metadata'), null, stepStartedAt);
        record.httpAttempts += Math.max(1, Math.min(policy.maxAttempts,
          stepMetadata.attempts));
        if (!checkActive(record)) return view(record);
        safeJson(response?.data, 4 * 1024 * KiB, 'model_response_invalid');
        const sanitized = redactKnown(response.data, record.credential);
        const choice = sanitized?.choices?.[0];
        const message = choice?.message;
        const finish = choice?.finish_reason;
        if (!plain(message)) fail('model_response_invalid', 'The model returned an invalid response.');
        if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
          if (message.content !== null && message.content !== undefined
              && typeof message.content !== 'string') {
            fail('model_response_invalid', 'The model returned an invalid tool message.');
          }
          if (!['tool_calls', 'stop'].includes(finish)) fail('answer_incomplete', 'The model did not complete its tool batch.');
          const calls = validateToolCalls(record, message.tool_calls);
          // Preserve every call ID and function in the assistant turn. Arguments
          // are normalized only to remove a known credential echoed by a model.
          const cleanCalls = calls.map(call => ({ ...call.raw, function: {
            ...call.raw.function, arguments: JSON.stringify(call.args),
          } }));
          const assistant = assistantMessage({ ...message, tool_calls: cleanCalls });
          safeJson([...record.messages, assistant], HISTORY_LIMIT, 'context_too_large');
          record.messages.push(assistant);
          record.toolCalls += calls.length;
          for (const call of calls) record.seenCallIds.add(call.id);
          const results = new Map();
          const requests = [];
          for (const call of calls) {
            if (!checkActive(record)) return view(record);
            if (call.name === 'codex_tool') {
              requests.push({ request_id: call.id, tool_name: call.args.name, arguments: call.args.arguments });
            } else {
              results.set(call.id, await localTool(record, call));
            }
          }
          if (requests.length) {
            // The host must be able to review the exact files before a brokered check.
            record.artifacts = await collectArtifacts(record);
            if (!checkActive(record)) return view(record);
            record.pending = { calls, results, requests };
            record.state = 'waiting_for_tools';
            return view(record);
          }
          for (const call of calls) record.messages.push(toolMessage(call.id, results.get(call.id)));
          continue;
        }
        if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.length)) {
          fail('model_response_invalid', 'The model returned an invalid tool list.');
        }
        if (finish !== 'stop' || typeof message.content !== 'string' || !message.content.trim()) {
          fail(finish === 'length' ? 'answer_truncated' : 'answer_incomplete',
            'The model did not return a complete final answer.');
        }
        if (bytes(message.content) > TASK_LIMIT) fail('model_response_invalid', 'The final answer exceeds its byte limit.');
        record.artifacts = await collectArtifacts(record);
        if (!checkActive(record)) return view(record);
        record.answer = message.content;
        record.state = 'completed';
        record.messages = null;
        record.credential = null;
        return view(record);
      }
    } catch (error) {
      if (record.cancelled) { record.state = 'cancelled'; return view(record); }
      return markFailed(record, error);
    } finally { record.busy = false; }
  }

  async function start(args, control = {}) {
    alive();
    const input = validateStart(args);
    for (const record of records.values()) {
      if (record.state === 'waiting_for_tools' && !record.busy && expired(record)) {
        markFailed(record, new AgentRuntimeError('deadline_exceeded', 'The agent time limit was reached.'));
      }
    }
    while (records.size >= MAX_TASKS) {
      const terminalId = [...records].find(([, record]) => TERMINAL.has(record.state))?.[0];
      if (!terminalId) fail('task_limit', 'The runtime has reached its task limit.');
      records.delete(terminalId);
    }
    const record = { id: randomUUID(), modelAlias: input.model, modelId: null,
      state: 'running', startedAt: Date.now(), deadlineAt: Date.now() + input.totalTimeoutMs,
      maxSteps: input.maxSteps, maxToolCalls: input.maxToolCalls,
      maxHttpAttempts: Math.min(18, input.maxSteps * 3), maxOutputTokens: input.maxOutputTokens,
      steps: 0, toolCalls: 0, httpAttempts: 0, busy: true, cancelled: false,
      seenCallIds: new Set(), pluginToolNames: new Set(input.pluginTools.map(item => item.name)),
      tools: null, baseline: new Map(), pending: null,
      answer: null, artifacts: null, config: null, credential: null, messages: null,
      scratchDir: null, network: null };
    records.set(record.id, record);
    let unbind;
    try {
      unbind = bindSignal(record, control);
      if (record.cancelled) { record.state = 'cancelled'; return view(record); }
      record.config = await readConfig(stateDir);
      if (record.cancelled) { record.state = 'cancelled'; return view(record); }
      record.modelId = record.config?.models?.[input.model];
      if (typeof record.modelId !== 'string' || !record.modelId) {
        fail('model_unavailable', 'The requested model alias is not configured.');
      }
      record.credential = await readCredential(record.config, stateDir);
      if (record.cancelled) { record.state = 'cancelled'; return view(record); }
      if (typeof record.credential !== 'string' || !record.credential) {
        fail('credential_unavailable', 'The credential is unavailable.');
      }
      if (containsKnown(input.pluginTools, record.credential)) {
        fail('invalid_argument', 'A plugin tool definition contains a protected credential.');
      }
      record.tools = toolSpecs(input.pluginTools);
      await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
      if (record.cancelled) { record.state = 'cancelled'; return view(record); }
      const rootDetails = await safeStat(scratchRoot);
      if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
        fail('scratch_unavailable', 'The scratch root is unsafe.');
      }
      const canonicalRoot = await realpath(scratchRoot);
      if (record.cancelled) { record.state = 'cancelled'; return view(record); }
      record.scratchDir = await realpath(await mkdtemp(join(canonicalRoot, 'task-')));
      if (record.cancelled) { record.state = 'cancelled'; return view(record); }
      for (const file of input.files) {
        if (record.cancelled) { record.state = 'cancelled'; return view(record); }
        const content = redactKnown(file.content, record.credential);
        await writeText(record, file.path, content);
        record.baseline.set(file.path, hash(content));
      }
      const catalog = redactKnown(input.pluginTools.map(tool => ({ name: tool.name, description: tool.description,
        input_schema: tool.input_schema ?? { type: 'object' } })), record.credential);
      record.messages = [
        { role: 'system', content: 'You are a DeepSeek agent operating only in an isolated scratch directory. Use list_files, read_file, and write_file for files. Use codex_tool only for the explicitly allowlisted host tools. Never claim a tool ran unless its result was returned. Produce a final nonempty answer when finished. Allowed Codex host tools and their argument schemas: '
          + JSON.stringify(catalog) },
        { role: 'user', content: redactKnown(input.task, record.credential) },
      ];
      ensureHistory(record);
      return await drive(record);
    } catch (error) {
      if (record.cancelled) { record.state = 'cancelled'; return view(record); }
      return markFailed(record, error);
    } finally { record.busy = false; unbind?.(); }
  }

  async function resume(args, control = {}) {
    alive();
    if (!plain(args)) fail('invalid_argument', 'Invalid resume arguments.');
    const record = find(args.task_id);
    if (record.state !== 'waiting_for_tools' || record.busy || !record.pending) {
      fail('invalid_state', 'The task is not waiting for host tool results.');
    }
    if (!Array.isArray(args.results) || args.results.length !== record.pending.requests.length) {
      fail('invalid_argument', 'All pending host tool results are required exactly once.');
    }
    const expected = new Set(record.pending.requests.map(item => item.request_id));
    const encoded = new Map();
    for (const item of args.results) {
      if (!plain(item) || typeof item.request_id !== 'string' || !expected.has(item.request_id)
          || encoded.has(item.request_id) || !Object.hasOwn(item, 'result')) {
        fail('invalid_argument', 'A host tool result ID is unknown or duplicated.');
      }
      encoded.set(item.request_id, safeJson(redactKnown(item.result, record.credential),
        TOOL_RESULT_LIMIT, 'tool_result_invalid'));
    }
    if (expired(record)) return markFailed(record, new AgentRuntimeError('deadline_exceeded', 'The agent time limit was reached.'));
    const pending = record.pending;
    record.busy = true;
    let unbind;
    try {
      unbind = bindSignal(record, control);
      if (record.cancelled) { record.state = 'cancelled'; return view(record); }
      for (const call of pending.calls) {
        const content = pending.results.get(call.id) ?? encoded.get(call.id);
        record.messages.push(toolMessage(call.id, content));
      }
      record.pending = null;
      record.state = 'running';
      return await drive(record);
    } finally { record.busy = false; unbind?.(); }
  }

  async function status(args) {
    alive();
    const record = find(args?.task_id);
    if (record.state === 'waiting_for_tools' && expired(record)) {
      markFailed(record, new AgentRuntimeError('deadline_exceeded', 'The agent time limit was reached.'));
    }
    return { ...metadata(record), ...(record.state === 'waiting_for_tools'
      ? { pending_requests: record.pending.requests.length } : {}),
    ...(record.state === 'failed' && record.network ? { network: record.network } : {}) };
  }

  async function cancel(args) {
    alive();
    const record = find(args?.task_id);
    if (TERMINAL.has(record.state)) return metadata(record);
    record.cancelled = true;
    record.state = record.busy ? 'cancelling' : 'cancelled';
    if (!record.busy) { record.pending = null; record.messages = null; record.credential = null; }
    return metadata(record);
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    for (const record of records.values()) {
      if (!TERMINAL.has(record.state)) {
        record.cancelled = true;
        record.state = record.busy ? 'cancelling' : 'cancelled';
      }
      record.pending = null;
      if (!record.busy) { record.messages = null; record.credential = null; }
    }
    records.clear();
  }
  return { start, resume, status, cancel, dispose };
}
