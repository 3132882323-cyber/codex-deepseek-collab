import {createAgentRuntime} from './deepseek-agent-runtime.mjs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const FALLBACK_PROTOCOL = '2025-06-18';
const MAX_LINE = 1024 * 1024;
const INTERNAL_ERROR = 'Internal error';

const TOOLS = [
  {
    name: 'deepseek_agent_start',
    description:
      'Run a bounded Flash or Pro external agent. It can edit its isolated scratch files and request allowed Codex plugin tools. Execute pending requests in the host and continue.',
    inputSchema: {
      type: 'object',
      required: ['task', 'model'],
      additionalProperties: false,
      properties: {
        task: {type: 'string', minLength: 1, maxLength: 65536},
        model: {type: 'string', enum: ['flash', 'pro']},
        files: {
          type: 'array',
          maxItems: 64,
          items: {
            type: 'object',
            required: ['path', 'content'],
            additionalProperties: false,
            properties: {
              path: {type: 'string', maxLength: 240},
              content: {type: 'string', maxLength: 65536},
            },
          },
        },
        plugin_tools: {
          type: 'array',
          maxItems: 32,
          items: {
            type: 'object',
            required: ['name', 'description'],
            additionalProperties: false,
            properties: {
              name: {type: 'string', minLength: 1, maxLength: 512},
              description: {type: 'string', maxLength: 2048},
              input_schema: {type: 'object', additionalProperties: true},
            },
          },
        },
        max_steps: {type: 'integer', minimum: 1, maximum: 12},
        max_tool_calls: {type: 'integer', minimum: 1, maximum: 32},
        total_timeout_ms: {type: 'integer', minimum: 1, maximum: 900000},
        max_output_tokens: {type: 'integer', minimum: 32, maximum: 8192},
      },
    },
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
  },
  {
    name: 'deepseek_agent_continue',
    description:
      'Provide results for pending Codex plugin tool requests from an external agent and continue it. The host executes the requested plugin tools under existing permission scopes.',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'results'],
      additionalProperties: false,
      properties: {
        task_id: {type: 'string'},
        results: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: {
            type: 'object',
            required: ['request_id', 'result'],
            additionalProperties: false,
            properties: {
              request_id: {type: 'string'},
              result: {},
            },
          },
        },
      },
    },
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
  },
  {
    name: 'deepseek_agent_status',
    description: 'Report the current state of an external agent task.',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      additionalProperties: false,
      properties: {task_id: {type: 'string'}},
    },
    annotations: {readOnlyHint: true, idempotentHint: true, openWorldHint: false},
  },
  {
    name: 'deepseek_agent_cancel',
    description: 'Cancel an external agent task. The host executes any requested plugin tools under existing permission scopes.',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      additionalProperties: false,
      properties: {task_id: {type: 'string'}},
    },
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
  },
];

const TOOL_METHODS = {
  deepseek_agent_start: 'start',
  deepseek_agent_continue: 'resume',
  deepseek_agent_status: 'status',
  deepseek_agent_cancel: 'cancel',
};

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOwn(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function validId(id) {
  return id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

export function createMcpServer({runtime = createAgentRuntime(), input = process.stdin, output = process.stdout} = {}) {
  let closed = false;
  let disposal;
  let pieces = [];
  let bufferedBytes = 0;
  let discarding = false;
  let accepting = true;
  const active = new Map();
  const keyOf = (id) => (id === null ? 'null' : typeof id === 'number' ? `n:${id}` : `s:${id}`);

  function dispose() {
    if (!disposal) {
      try { disposal = Promise.resolve(runtime.dispose()).catch(() => {}); }
      catch { disposal = Promise.resolve(); }
    }
    return disposal;
  }

  function write(obj) {
    if (closed || output.destroyed || output.writableEnded) return;
    try {
      output.write(JSON.stringify(obj) + '\n');
    } catch {}
  }

  function sendResult(id, result) {
    write({jsonrpc: '2.0', id, result});
  }

  function sendError(id, code, message) {
    write({jsonrpc: '2.0', id, error: {code, message}});
  }

  function textResult(value) {
    const isError = isObject(value) && value.state === 'failed';
    return {content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value, isError};
  }

  function handleMessage(msg) {
    if (!isObject(msg)) {
      sendError(null, -32600, 'Invalid Request');
      return;
    }
    const hasMethod = hasOwn(msg, 'method');
    const isNotification = hasMethod && !hasOwn(msg, 'id');
    const rawId = hasOwn(msg, 'id') ? msg.id : undefined;
    const idValid = !hasOwn(msg, 'id') || validId(rawId);

    if (!hasMethod) {
      // Responses to this tool-only server are ignored; other shapes are invalid.
      if (!(hasOwn(msg, 'id') && (hasOwn(msg, 'result') || hasOwn(msg, 'error')))) {
        sendError(idValid && rawId !== undefined ? rawId : null, -32600, 'Invalid Request');
      }
      return;
    }
    if (typeof msg.method !== 'string') {
      if (!isNotification && idValid) sendError(rawId, -32600, 'Invalid Request');
      return;
    }
    if (isNotification) {
      if (msg.jsonrpc === '2.0' && msg.method === 'notifications/cancelled'
          && isObject(msg.params) && hasOwn(msg.params, 'requestId') && validId(msg.params.requestId)) {
        active.get(keyOf(msg.params.requestId))?.abort();
      }
      return;
    }
    if (!idValid) {
      sendError(null, -32600, 'Invalid Request');
      return;
    }
    const id = rawId;
    const key = keyOf(id);
    if (active.has(key)) {
      // One in-flight id represents one submission. Do not dispatch or answer twice.
      return;
    }
    if (msg.jsonrpc !== '2.0') {
      sendError(id, -32600, 'Invalid Request');
      return;
    }
    if (msg.method === 'ping') {
      sendResult(id, {});
      return;
    }
    if (msg.method === 'initialize') {
      const params = isObject(msg.params) ? msg.params : {};
      const requested = params.protocolVersion;
      const protocolVersion = PROTOCOLS.includes(requested) ? requested : FALLBACK_PROTOCOL;
      sendResult(id, {
        protocolVersion,
        capabilities: {tools: {}},
        serverInfo: {name: 'codex-deepseek-collab', version: '0.2.0'},
        instructions:
          'This server coordinates external Pro/Flash agents. Pending codex_tool requests are executed by the host under existing permission scopes; no credentials are transferred.',
      });
      return;
    }
    if (msg.method === 'tools/list') {
      sendResult(id, {tools: TOOLS});
      return;
    }
    if (msg.method !== 'tools/call') {
      sendError(id, -32601, 'Method not found');
      return;
    }
    const params = msg.params;
    if (!isObject(params) || typeof params.name !== 'string') {
      sendError(id, -32602, 'Invalid params');
      return;
    }
    const method = hasOwn(TOOL_METHODS, params.name) ? TOOL_METHODS[params.name] : null;
    if (!method) {
      sendError(id, -32602, 'Invalid params');
      return;
    }
    const args = hasOwn(params, 'arguments') ? params.arguments : {};
    if (!isObject(args)) {
      sendError(id, -32602, 'Invalid params');
      return;
    }
    const controller = new AbortController();
    active.set(key, controller);
    let promise;
    try {
      promise = Promise.resolve(runtime[method](args, {signal: controller.signal}));
    } catch {
      promise = Promise.reject(new Error(INTERNAL_ERROR));
    }
    promise.then(
      (value) => {
        active.delete(key);
        try {
          if (!isObject(value)) throw new Error(INTERNAL_ERROR);
          sendResult(id, textResult(value));
        } catch { sendError(id, -32603, INTERNAL_ERROR); }
      },
      () => {
        active.delete(key);
        if (hasOwn(msg, 'id')) sendError(id, -32603, INTERNAL_ERROR);
      },
    );
  }

  function processLine(line) {
    if (line === '') return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      sendError(null, -32700, 'Parse error');
      return;
    }
    if (Array.isArray(msg)) {
      sendError(null, -32600, 'Invalid Request');
      return;
    }
    try {
      handleMessage(msg);
    } catch {
      const id = isObject(msg) && hasOwn(msg, 'id') && validId(msg.id) ? msg.id : null;
      if (!isObject(msg) || !(hasOwn(msg, 'method') && !hasOwn(msg, 'id'))) sendError(id, -32603, INTERNAL_ERROR);
    }
  }

  function onData(chunk) {
    if (closed || !accepting) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    let start = 0;
    while (start < bytes.length) {
      const nl = bytes.indexOf(10, start);
      const end = nl === -1 ? bytes.length : nl;
      const piece = bytes.subarray(start, end);
      if (discarding) {
        if (nl === -1) return;
        discarding = false;
        start = nl + 1;
        continue;
      }
      if (bufferedBytes + piece.length > MAX_LINE) {
        pieces = [];
        bufferedBytes = 0;
        discarding = true;
        sendError(null, -32700, 'Parse error');
        if (nl === -1) return;
        discarding = false;
        start = nl + 1;
        continue;
      }
      if (piece.length) pieces.push(piece);
      bufferedBytes += piece.length;
      if (nl === -1) return;
      try {
        let line = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(pieces, bufferedBytes));
        if (line.endsWith('\r')) line = line.slice(0, -1);
        processLine(line);
      } catch { sendError(null, -32700, 'Parse error'); }
      pieces = [];
      bufferedBytes = 0;
      start = nl + 1;
    }
  }

  function onEnd() {
    if (!accepting) return;
    accepting = false;
    for (const controller of active.values()) controller.abort();
    pieces = [];
    bufferedBytes = 0;
    dispose();
  }

  input.on('data', onData);
  input.on('end', onEnd);
  input.on('close', onEnd);
  input.on('error', onEnd);

  return {
    async close() {
      if (closed) return;
      closed = true;
      accepting = false;
      for (const controller of active.values()) controller.abort();
      pieces = [];
      bufferedBytes = 0;
      try {
        input.removeListener('data', onData);
        input.removeListener('end', onEnd);
        input.removeListener('close', onEnd);
        input.removeListener('error', onEnd);
      } catch {}
      await dispose();
    },
  };
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(selfPath)) {
  try {
    const options = {};
    const flags = new Map([['--state-dir', 'stateDir'], ['--scratch-root', 'scratchRoot']]);
    for (let i = 2; i < process.argv.length; i++) {
      const key = flags.get(process.argv[i]);
      const value = process.argv[++i];
      if (!key || options[key] || !value || value.startsWith('--')) throw new Error();
      options[key] = resolve(value);
    }
    createMcpServer({runtime: createAgentRuntime(options)});
  } catch {
    process.stderr.write('Invalid agent server configuration.\n');
    process.exitCode = 1;
  }
}
