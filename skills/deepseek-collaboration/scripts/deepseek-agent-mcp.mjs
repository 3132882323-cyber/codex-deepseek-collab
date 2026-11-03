import {createAgentRuntime} from './deepseek-agent-runtime.mjs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const FALLBACK_PROTOCOL = '2025-06-18';
const MAX_INPUT_LINE = 16 * 1024 * 1024;
const MAX_OUTPUT_LINE = 64 * 1024 * 1024;
const MAX_DUPLICATED_RESULT = 8 * 1024 * 1024;
const INTERNAL_ERROR = 'Internal error';

const TOOLS = [
  {
    name: 'deepseek_agent_start',
    description:
      'Run a bounded Flash or Pro external agent with text and optional explicit image data URLs. The configured model profile controls image, context and output capabilities. Execute pending allowed plugin requests in the host and continue.',
    inputSchema: {
      type: 'object',
      required: ['task', 'model'],
      additionalProperties: false,
      properties: {
        task: {type: 'string', minLength: 1, maxLength: 2097152,
          description: 'Task text. The runtime enforces UTF-8 byte budgets separately from the provider token window.'},
        model: {type: 'string', enum: ['flash', 'pro']},
        images: {
          type: 'array', maxItems: 4,
          description: 'Explicit PNG, JPEG, WebP or GIF base64 data URLs only; no remote URLs or local paths. At most 2 MiB per image and 4 MiB total decoded image bytes, subject to the selected model profile.',
          items: {type: 'string', maxLength: 2796268,
            pattern: '^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$'},
        },
        reasoning_effort: {type: 'string', enum: ['none', 'low', 'high', 'max'],
          description: 'Uses the configured default when omitted. none disables thinking; other levels enable it. Reasoning shares each step generation budget with answer text and tool arguments; keep the user-selected effort and plan max_output_tokens explicitly.'},
        files: {
          type: 'array',
          maxItems: 128,
          items: {
            type: 'object',
            required: ['path', 'content'],
            additionalProperties: false,
            properties: {
              path: {type: 'string', maxLength: 512},
              content: {type: 'string', maxLength: 2097152},
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
        max_steps: {type: 'integer', minimum: 1, maximum: 4096, description: 'Phase allowance. Legacy default/max 12; configured long mode default 64, max 4096. Reaching it pauses with artifacts. Long mode has no cumulative step quota.'},
        max_tool_calls: {type: 'integer', minimum: 1, maximum: 16384, description: 'Phase allowance. Legacy default 24/max 32; long mode default 256/max 16384. Complete pending batches wait for enough credits without executing twice.'},
        total_timeout_ms: {type: 'integer', minimum: 1, maximum: 86400000, description: 'Initial task deadline. Legacy default 360000/max 900000 ms; long mode default 7200000/max 86400000 ms. Unexpired long checkpoints may extend the deadline without a cumulative time quota.'},
        max_output_tokens: {type: 'integer', minimum: 32, maximum: 393216,
          description: 'Per-step generation ceiling shared by reasoning, answer and tool arguments. Legacy default 4096. An explicitly configured long policy may select the declared route maximum when omitted, with no cumulative token quota; provider/context limits still apply. Explicit values take priority, and configured max-effort minimums still apply. Plan before the first request; never enlarge and replay an actual truncated response.'},
      },
    },
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
  },
  {
    name: 'deepseek_agent_continue',
    description:
      'Continue the same external agent task. waiting_for_tools requires exact one-time plugin results and no added budget. Paused step/tool limits require explicit corresponding credits. Long-mode time_slice can resume without credits, or extend the unexpired deadline when recovery.needs_deadline_extension is true; add a full time allowance rather than copying a stale minimum snapshot. No cumulative long-mode token/step/tool/recovery quota. Committed tools are not repeated. Same MCP process required; failed/truncated tasks are not restarted as retries.',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      additionalProperties: false,
      properties: {
        task_id: {type: 'string'},
        results: {
          type: 'array',
          minItems: 0,
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
        additional_steps: {type: 'integer', minimum: 1, maximum: 4096, description: 'Paused tasks only. Legacy per-call max 12/cumulative max 48; enabled long mode per-call max 4096, no cumulative quota.'},
        additional_tool_calls: {type: 'integer', minimum: 1, maximum: 16384, description: 'Paused tasks only. Legacy per-call max 24/cumulative max 96; enabled long mode per-call max 16384, no cumulative quota. Oversized batches stay paused until enough credits exist.'},
        extend_timeout_ms: {type: 'integer', minimum: 1, maximum: 86400000, description: 'Extend the original unexpired deadline. Legacy per-call max 360000/cumulative max 1800000 ms; long mode may add up to 86400000 ms per continuation without a cumulative time quota. Cancelled, expired or terminal tasks cannot be resurrected.'},
      },
    },
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
  },
  {
    name: 'deepseek_agent_status',
    description: 'Report task state. Paused tasks include validated artifacts and available recovery budgets for continuing the same task ID in this MCP process.',
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
      const encoded = JSON.stringify(obj);
      output.write((Buffer.byteLength(encoded, 'utf8') <= MAX_OUTPUT_LINE ? encoded : JSON.stringify({
        jsonrpc: '2.0', id: validId(obj.id) ? obj.id : null,
        error: {code: -32603, message: 'Response exceeds its byte limit'},
      })) + '\n');
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
    const serialized = JSON.stringify(value);
    // Keep the full result in structuredContent. Duplicating a large JSON result
    // inside a JSON text block adds another escaping layer and can exceed a frame.
    const text = Buffer.byteLength(serialized, 'utf8') <= MAX_DUPLICATED_RESULT
      ? serialized : 'The complete result is available in structuredContent.';
    return {content: [{type: 'text', text}], structuredContent: value, isError};
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
        serverInfo: {name: 'codex-deepseek-collab', version: '0.8.0'},
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
      if (bufferedBytes + piece.length > MAX_INPUT_LINE) {
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
