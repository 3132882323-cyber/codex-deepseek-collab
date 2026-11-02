// A small, dependency-free MCP stdio client used by offline tests and explicit
// live acceptance checks. It never prints child output or request parameters.
import { spawn } from 'node:child_process';

const MAX_LINE_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;

export class McpRpcError extends Error {
  constructor(error) {
    super(typeof error?.message === 'string' ? error.message : 'MCP request failed.');
    this.name = 'McpRpcError';
    this.code = error?.code;
    this.data = error?.data;
  }
}

export async function connectMcp({
  command = process.execPath,
  args = [],
  cwd,
  env = process.env,
  timeoutMs = 15_000,
  initialize = true,
  onNotification,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 360_000) {
    throw new TypeError('timeoutMs must be an integer from 1 to 360000.');
  }
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  const notifications = [];
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  let terminalError;
  let closed = false;
  let exitInfo;
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });

  function fail(error) {
    terminalError ??= error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(terminalError);
    }
    pending.clear();
  }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES && !buffer.includes('\n')) {
      fail(new Error('MCP stdout line exceeded the client limit.'));
      child.kill();
      return;
    }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try {
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('oversized line');
        message = JSON.parse(line);
        if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') throw new Error('invalid envelope');
      } catch {
        fail(new Error('MCP stdout contained an invalid JSON-RPC message.'));
        child.kill();
        return;
      }
      if (!Object.hasOwn(message, 'id')) {
        notifications.push(message);
        try { onNotification?.(message); } catch { /* Observers do not affect RPC delivery. */ }
        continue;
      }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (Object.hasOwn(message, 'error')) entry.reject(new McpRpcError(message.error));
      else if (Object.hasOwn(message, 'result')) entry.resolve(message.result);
      else entry.reject(new Error('MCP response had neither result nor error.'));
    }
  });
  child.stderr.on('data', chunk => {
    // Kept only for an explicit caller inspection; never included in exceptions.
    stderr = (stderr + chunk).slice(-MAX_STDERR_BYTES);
  });
  child.stdin.on('error', () => fail(new Error('MCP stdin became unavailable.')));
  child.on('error', error => {
    fail(new Error(error?.code === 'ENOENT' ? 'MCP command was not found.' : 'MCP child could not start.'));
    resolveExit({ code: null, signal: null });
  });
  child.on('close', (code, signal) => {
    exitInfo = { code, signal };
    if (buffer.trim()) fail(new Error('MCP stdout ended with an incomplete JSON-RPC message.'));
    fail(new Error('MCP child exited before the request completed.'));
    resolveExit(exitInfo);
  });

  function send(message) {
    if (terminalError) throw terminalError;
    if (closed || child.stdin.destroyed || child.stdin.writableEnded) throw new Error('MCP connection is closed.');
    child.stdin.write(JSON.stringify(message) + '\n');
  }

  function call(method, params, options = {}) {
    const duration = options.timeoutMs ?? timeoutMs;
    if (!Number.isInteger(duration) || duration < 1 || duration > 360_000) {
      return Promise.reject(new TypeError('timeoutMs must be an integer from 1 to 360000.'));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        try {
          send({ jsonrpc: '2.0', method: 'notifications/cancelled',
            params: { requestId: id, reason: 'Client request time limit reached.' } });
        } catch { /* The connection may already have ended. */ }
        reject(new Error('MCP request exceeded its client time limit.'));
      }, duration);
      pending.set(id, { resolve, reject, timer });
      try {
        send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function notify(method, params) {
    send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  async function close() {
    if (closed) return await exited;
    for (const id of pending.keys()) {
      try { notify('notifications/cancelled', { requestId: id, reason: 'Client connection closing.' }); }
      catch { /* Closing an unavailable transport is still bounded. */ }
    }
    closed = true;
    fail(new Error('MCP connection was closed.'));
    child.stdin.end();
    const killTimer = setTimeout(() => child.kill(), 1_000);
    const hardTimer = setTimeout(() => resolveExit({ code: null, signal: 'client-close-timeout' }), 3_000);
    try { return await exited; }
    finally { clearTimeout(killTimer); clearTimeout(hardTimer); }
  }

  const client = {
    call,
    notify,
    callTool: (name, arguments_ = {}, options) => call('tools/call', { name, arguments: arguments_ }, options),
    close,
    notifications,
    get stderr() { return stderr; },
    get exitInfo() { return exitInfo; },
  };
  if (initialize) {
    try {
      client.initialization = await call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bounded-mcp-acceptance', version: '1.0.0' },
      });
      notify('notifications/initialized');
    } catch (error) {
      await close();
      throw error;
    }
  }
  return client;
}

export const connect = connectMcp;
