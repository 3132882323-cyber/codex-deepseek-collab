// MCP protocol and runtime integration checks. No test uses a gateway, a real
// credential, a user's connection file, or an installed Codex configuration.
import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { PassThrough } from 'node:stream';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createAgentRuntime } from '../skills/deepseek-collaboration/scripts/deepseek-agent-runtime.mjs';
import { createMcpServer } from '../skills/deepseek-collaboration/scripts/deepseek-agent-mcp.mjs';
import { connectMcp } from './mcp-client.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const test = (name, fn) => nodeTest(name, { timeout: 10_000 }, fn);
const entrypoint = join(project, 'skills', 'deepseek-collaboration', 'scripts', 'deepseek-agent-mcp.mjs');
const tempRoot = realpathSync(tmpdir());
const expectedNames = ['deepseek_agent_start', 'deepseek_agent_continue', 'deepseek_agent_status', 'deepseek_agent_cancel'];
globalThis.fetch = async () => { throw new Error('Offline MCP tests forbid network access.'); };

function ownedTemp(t) {
  const base = mkdtempSync(join(tempRoot, 'codex-deepseek-mcp-test-'));
  t.after(() => {
    const actual = realpathSync(base);
    const scoped = relative(tempRoot, actual);
    assert.ok(actual === resolve(base) && scoped && !isAbsolute(scoped)
      && scoped !== '..' && !scoped.startsWith('..' + sep) && basename(actual).startsWith('codex-deepseek-mcp-test-'));
    rmSync(actual, { recursive: true, force: true });
  });
  return base;
}

function filesBelow(directory) {
  try {
    return readdirSync(directory).flatMap(name => {
      const path = join(directory, name);
      return lstatSync(path).isDirectory() ? filesBelow(path) : [path];
    });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function mockRuntime(overrides = {}) {
  const calls = [];
  const runtime = Object.fromEntries(['start', 'resume', 'status', 'cancel'].map(method => [method, async args => {
    calls.push({ method, args: structuredClone(args) });
    return { state: method === 'cancel' ? 'cancelled' : 'waiting_for_tools', task_id: 'synthetic-task',
      model: 'deepseek-test-fixture', steps: 1, tool_calls: 1, requests: [] };
  }]));
  runtime.dispose = async () => {};
  return { runtime: Object.assign(runtime, overrides), calls };
}

function inMemory(t, runtime) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  const pending = new Map();
  const observers = new Set();
  let nextId = 1;
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { assert.fail('MCP stdout must contain JSON-RPC messages only.'); }
      assert.equal(message.jsonrpc, '2.0');
      messages.push(message);
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.resolve(message);
      }
      for (const observer of observers) observer(message);
    }
  });
  const server = createMcpServer({ runtime, input, output });
  t.after(async () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Test MCP server closed.')); }
    pending.clear();
    await server.close();
    input.destroy();
    output.destroy();
  });
  function rpc(method, params, id = nextId++) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Offline MCP response timed out.')); }, 2_000);
      pending.set(id, { resolve, reject, timer });
      input.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
    });
  }
  function raw(line, predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { observers.delete(observer); reject(new Error('Offline malformed-input response timed out.')); }, 2_000);
      const observer = message => {
        if (!predicate(message)) return;
        observers.delete(observer);
        clearTimeout(timer);
        resolve(message);
      };
      observers.add(observer);
      if (Array.isArray(line)) {
        for (const chunk of line) input.write(chunk);
        input.write('\n');
      } else input.write(line + '\n');
    });
  }
  return { rpc, raw, messages,
    notify: (method, params) => input.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n'),
  };
}

async function initialize(connection) {
  const response = await connection.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'synthetic-offline-test', version: '1.0.0' } });
  assert.ok(response.result, 'initialize must succeed');
  connection.notify('notifications/initialized');
  return response.result;
}
function toolPayload(response) {
  assert.ok(response.result && !response.result.isError, 'the MCP tool call must succeed');
  const result = response.result;
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find(item => item.type === 'text')?.text;
  assert.equal(typeof text, 'string', 'tool results need inspectable structured or JSON text content');
  return JSON.parse(text);
}
function isRefused(response) {
  assert.ok(response.error || response.result?.isError, 'malformed or unknown calls must explicitly fail');
}

test('MCP initializes, advertises exactly four tools, accepts initialized, and answers ping', async t => {
  const { runtime, calls } = mockRuntime();
  const connection = inMemory(t, runtime);
  const init = await initialize(connection);
  assert.equal(typeof init.protocolVersion, 'string');
  assert.equal(typeof init.serverInfo?.name, 'string');
  assert.ok(init.capabilities?.tools);
  const listing = await connection.rpc('tools/list');
  assert.deepEqual(listing.result.tools.map(tool => tool.name).sort(), [...expectedNames].sort());
  for (const tool of listing.result.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema?.type, 'object');
  }
  const continuation=listing.result.tools.find(tool=>tool.name==='deepseek_agent_continue').inputSchema;
  assert.deepEqual(continuation.required,['task_id']);
  assert.equal(continuation.properties.additional_steps.maximum,4096);
  assert.equal(continuation.properties.additional_tool_calls.maximum,16384);
  assert.equal(continuation.properties.extend_timeout_ms.maximum,86400000);
  const ping = await connection.rpc('ping', undefined, 0);
  assert.equal(ping.id, 0);
  assert.deepEqual(ping.result, {});
  assert.equal(connection.messages.length, 3, 'initialized notifications must not receive a response');
  assert.equal(calls.length, 0);
});

test('MCP tools dispatch start, continue, status, and cancel to the exact runtime methods', async t => {
  const { runtime, calls } = mockRuntime();
  const connection = inMemory(t, runtime);
  await initialize(connection);
  const arguments_ = [
    { task: 'Synthetic task', model: 'flash', files: [{ path: 'input.txt', content: 'synthetic' }] },
    { task_id: 'synthetic-task', results: [{ request_id: 'request-one', result: { value: 4 } }] },
    { task_id: 'synthetic-task' },
    { task_id: 'synthetic-task' },
  ];
  for (let index = 0; index < expectedNames.length; index++) {
    const payload = toolPayload(await connection.rpc('tools/call', { name: expectedNames[index], arguments: arguments_[index] }));
    assert.equal(payload.task_id, 'synthetic-task');
  }
  assert.deepEqual(calls, ['start', 'resume', 'status', 'cancel'].map((method, index) => ({ method, args: arguments_[index] })));
});

test('malformed JSON and invalid JSON-RPC envelopes are rejected while the server remains usable', async t => {
  const { runtime, calls } = mockRuntime();
  const connection = inMemory(t, runtime);
  await initialize(connection);
  const parse = await connection.raw('{broken', message => message.id === null && message.error?.code === -32700);
  assert.equal(parse.error.code, -32700);
  for (const value of [null, [], { jsonrpc: '1.0', id: 44, method: 'ping' }, { jsonrpc: '2.0', id: 45, method: 3 }]) {
    const invalid = await connection.raw(JSON.stringify(value), message => message.error?.code === -32600);
    assert.equal(invalid.error.code, -32600);
  }
  assert.deepEqual((await connection.rpc('ping')).result, {});
  assert.equal(calls.length, 0);
});

test('unknown methods and tool names never reach runtime or run as notifications', async t => {
  const { runtime, calls } = mockRuntime();
  const connection = inMemory(t, runtime);
  await initialize(connection);
  const unknown = await connection.rpc('synthetic/unknown', {});
  assert.equal(unknown.error?.code, -32601);
  isRefused(await connection.rpc('tools/call', { name: 'execute_shell', arguments: {} }));
  connection.notify('tools/call', { name: 'deepseek_agent_start', arguments: { task: 'do not execute', model: 'flash' } });
  await connection.rpc('ping');
  assert.equal(calls.length, 0);
});

test('malformed tools/call parameters are refused before runtime dispatch', async t => {
  const { runtime, calls } = mockRuntime();
  const connection = inMemory(t, runtime);
  await initialize(connection);
  for (const params of [undefined, null, [], {}, { name: 42, arguments: {} },
    { name: 'deepseek_agent_start', arguments: [] }, { name: 'deepseek_agent_start', arguments: 'synthetic' }]) {
    isRefused(await connection.rpc('tools/call', params));
  }
  assert.equal(calls.length, 0);
});

test('stdio framing preserves split UTF-8 and recovers after malformed or oversized lines', async t => {
  const { runtime, calls } = mockRuntime();
  const connection = inMemory(t, runtime);
  await initialize(connection);
  const task = '中文合成任务 🧪';
  const message = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/call',
    params: { name: 'deepseek_agent_start', arguments: { task, model: 'flash' } } }));
  const split = message.indexOf(Buffer.from('中')) + 1;
  const response = await connection.raw([message.subarray(0, split), message.subarray(split, split + 1), message.subarray(split + 1)],
    value => value.id === 91);
  assert.ok(response.result);
  assert.equal(calls[0].args.task, task);
  const invalid = await connection.raw([Buffer.from([0xff, 0xfe])], value => value.error?.code === -32700);
  assert.equal(invalid.error.code, -32700);
  const oversizedFrame = JSON.stringify({jsonrpc:'2.0',id:92,method:'tools/call',params:{
    name:'deepseek_agent_start',arguments:{model:'flash',task:'X'.repeat(16*1024*1024)}}});
  const oversized = await connection.raw(oversizedFrame, value => value.error?.code === -32700);
  assert.equal(oversized.error.code, -32700);
  assert.deepEqual((await connection.rpc('ping')).result, {});
  assert.equal(calls.length, 1);
});

for (const [kind,content,count] of [
  ['quotes','"'.repeat(1536*1024),2],
  ['control characters','\u0001'.repeat(500*1024),3],
]) {
  test(`large completed results retain full artifacts across MCP framing: ${kind}`,async t=>{
    const artifacts=Array.from({length:count},(_,index)=>({path:`part-${index}.txt`,content,sha256:'synthetic-hash'}));
    const {runtime}=mockRuntime({start:async()=>({state:'completed',task_id:'synthetic-task',answer:'Done.',artifacts})});
    const connection=inMemory(t,runtime);await initialize(connection);
    const response=await connection.rpc('tools/call',{name:'deepseek_agent_start',arguments:{task:'synthetic',model:'flash'}});
    const payload=toolPayload(response);
    assert.equal(payload.state,'completed');
    assert.equal(payload.answer,'Done.');
    assert.equal(payload.artifacts.length,count);
    for(const artifact of payload.artifacts){
      assert.equal(artifact.content.length,content.length);
      assert.ok(artifact.content===content,'artifact must arrive without truncation or escaping changes');
    }
    if(kind==='control characters')assert.ok(response.result.content[0].text.length<1000,'large-result text should direct clients to the complete structured result');
  });
}

test('runtime errors are reported without raw credential, task, or provider details', async t => {
  const secret = 'sk-SYNTHETIC-MCP-ERROR-DO-NOT-EMIT';
  const marker = 'SYNTHETIC-PRIVATE-PROVIDER-BODY';
  const { runtime } = mockRuntime({ start: async () => { throw new Error(secret + ' ' + marker); } });
  const connection = inMemory(t, runtime);
  await initialize(connection);
  const response = await connection.rpc('tools/call', { name: 'deepseek_agent_start', arguments: { task: 'synthetic', model: 'flash' } });
  isRefused(response);
  assert.doesNotMatch(JSON.stringify(response), /sk-SYNTHETIC-MCP-ERROR|SYNTHETIC-PRIVATE-PROVIDER-BODY/);
  assert.deepEqual((await connection.rpc('ping')).result, {});
});

test('MCP supports status and cancellation while another tool request is in flight', async t => {
  let release;
  let entered;
  const began = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const { runtime, calls } = mockRuntime({ resume: async args => { calls.push({ method: 'resume', args }); entered(); return delayed; } });
  const connection = inMemory(t, runtime);
  await initialize(connection);
  const continued = connection.rpc('tools/call', { name: 'deepseek_agent_continue', arguments: { task_id: 'synthetic-task', results: [] } });
  await began;
  const status = toolPayload(await connection.rpc('tools/call', { name: 'deepseek_agent_status', arguments: { task_id: 'synthetic-task' } }));
  assert.equal(status.task_id, 'synthetic-task');
  const cancelled = toolPayload(await connection.rpc('tools/call', { name: 'deepseek_agent_cancel', arguments: { task_id: 'synthetic-task' } }));
  assert.equal(cancelled.state, 'cancelled');
  release({ state: 'cancelled', task_id: 'synthetic-task' });
  assert.equal(toolPayload(await continued).state, 'cancelled');
});

test('real runtime plus MCP resumes the same checkpoint after one explicit broker round trip', async t => {
  const base = ownedTemp(t);
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  const calls = [];
  const code = 'export const double = value => value * 2;\n';
  const runtime = createAgentRuntime({ stateDir, scratchRoot: join(base, 'scratch'),
    loadConfig: async () => ({ protocol: 'openai', base_url: 'https://api.example.test/v1',
      allowed_origin: 'https://api.example.test', model: 'deepseek-test-fixture', models: { flash: 'deepseek-test-fixture' }, credential_source: 'env' }),
    loadCredential: async () => 'sk-SYNTHETIC-MCP-INTEGRATION-DO-NOT-USE',
    request: async (_config, _path, _credential, body) => {
      const index = calls.length;
      calls.push(structuredClone(body));
      if (index === 0) return { data: { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'call_recipe', type: 'function', function: { name: 'codex_tool', arguments: JSON.stringify({ name: 'get_recipe', arguments: { kind: 'double' } }) } }] } }] }, metadata: { attempts: 1 } };
      if (index === 1) {
        assert.ok(body.messages.some(message => message.role === 'tool' && message.content.includes('multiply by 2')));
        return { data: { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
          tool_calls: [{ id: 'call_write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'dist/double.mjs', content: code }) } }] } }] }, metadata: { attempts: 1 } };
      }
      assert.equal(index, 2, 'integration must not make an extra model request');
      return { data: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Created dist/double.mjs.' } }] }, metadata: { attempts: 1 } };
    },
  });
  const connection = inMemory(t, runtime);
  await initialize(connection);
  const waiting = toolPayload(await connection.rpc('tools/call', { name: 'deepseek_agent_start', arguments: {
    task: 'Create a JavaScript double function using the recipe.', model: 'flash', max_steps: 1,
    plugin_tools: [{ name: 'get_recipe', description: 'Return a synthetic requested recipe.', input_schema: { type: 'object' } }],
  } }));
  assert.equal(waiting.state, 'waiting_for_tools');
  assert.equal(calls.length, 1);
  assert.equal(waiting.requests[0].tool_name, 'get_recipe');
  const paused = toolPayload(await connection.rpc('tools/call', { name: 'deepseek_agent_continue', arguments: {
    task_id: waiting.task_id, results: [{ request_id: waiting.requests[0].request_id, result: { instruction: 'multiply by 2' } }],
  } }));
  assert.equal(paused.state,'paused');
  assert.equal(paused.pause_reason,'step_limit');
  assert.equal(paused.task_id,waiting.task_id);
  assert.equal(calls.length,1);
  const done=toolPayload(await connection.rpc('tools/call',{name:'deepseek_agent_continue',arguments:{
    task_id:paused.task_id,additional_steps:2,
  }}));
  assert.equal(done.state, 'completed');
  assert.equal(calls.length, 3);
  const artifact = done.artifacts.find(item => item.path === 'dist/double.mjs');
  assert.ok(artifact);
  assert.equal(artifact.content, code);
  const module = await import('data:text/javascript;base64,' + Buffer.from(artifact.content).toString('base64'));
  assert.equal(module.double(21), 42);
  const stale = await connection.rpc('tools/call', { name: 'deepseek_agent_continue', arguments: {
    task_id: waiting.task_id, results: [{ request_id: waiting.requests[0].request_id, result: 'duplicate' }],
  } });
  isRefused(stale);
  assert.equal(calls.length, 3);
});

test('MCP cancellation notifications stop a real start before late tool effects', async t => {
  const base = ownedTemp(t);
  const scratchRoot = join(base, 'scratch');
  let entered;
  let release;
  const begun = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const runtime = createAgentRuntime({ stateDir: join(base, 'state'), scratchRoot,
    loadConfig: async () => ({ protocol: 'openai', base_url: 'https://api.example.test/v1',
      allowed_origin: 'https://api.example.test', model: 'deepseek-test-fixture',
      models: { flash: 'deepseek-test-fixture' }, credential_source: 'env' }),
    loadCredential: async () => 'sk-SYNTHETIC-MCP-CANCEL-DO-NOT-USE',
    request: async () => { calls++; entered(); return delayed; },
  });
  const connection = inMemory(t, runtime);
  await initialize(connection);
  const running = connection.rpc('tools/call', { name: 'deepseek_agent_start',
    arguments: { task: 'Create a synthetic file.', model: 'flash' } }, 137);
  await begun;
  connection.notify('notifications/cancelled', { requestId: 137, reason: 'Synthetic cancellation.' });
  // A following ping observes that the cancellation message has been consumed.
  assert.deepEqual((await connection.rpc('ping')).result, {});
  release({ data: { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: [{ id: 'call_late', type: 'function', function: { name: 'write_file',
      arguments: JSON.stringify({ path: 'must-not-write.txt', content: 'SYNTHETIC' }) } }] } }] }, metadata: { attempts: 1 } });
  const cancelled = toolPayload(await running);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(calls, 1);
  assert.equal(filesBelow(scratchRoot).length, 0);
});

test('the actual stdio entrypoint handshakes and serves concurrent read-only calls without credentials', async t => {
  const base = ownedTemp(t);
  const client = await connectMcp({ args: [entrypoint, '--state-dir', join(base, 'empty-state')], cwd: project,
    env: { ...process.env, DEEPSEEK_API_KEY: '', NODE_OPTIONS: '' }, timeoutMs: 5_000 });
  t.after(() => client.close());
  assert.equal(typeof client.initialization.serverInfo?.name, 'string');
  const [listing, ping, unknownTask] = await Promise.all([
    client.call('tools/list'), client.call('ping'), client.callTool('deepseek_agent_status', { task_id: 'unknown-synthetic-task' })
      .then(result => ({ result }), error => ({ error })),
  ]);
  assert.deepEqual(listing.tools.map(tool => tool.name).sort(), [...expectedNames].sort());
  assert.deepEqual(ping, {});
  assert.ok(unknownTask.result?.isError || unknownTask.error?.code,
    'an unknown task must fail without touching configuration or credentials');
  await assert.rejects(() => client.call('synthetic/unknown'), error => error.code === -32601);
  assert.doesNotMatch(client.stderr, /credential\.dpapi|sk-[A-Za-z0-9]{20}/);
});

test('stdio client correlates out-of-order IDs and keeps stderr out of native errors', async t => {
  const base = ownedTemp(t);
  const script = join(base, 'synthetic-server.mjs');
  writeFileSync(script, `import { createInterface } from 'node:readline';
const input = createInterface({input:process.stdin});
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'slow') setTimeout(() => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{value:'slow'}})+'\\n'),25);
  else if (request.method === 'fast') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{value:'fast'}})+'\\n');
  else if (request.method === 'crash') { process.stderr.write('SYNTHETIC-PRIVATE-STDERR'); process.exit(2); }
});\n`);
  const client = await connectMcp({ args: [script], initialize: false, timeoutMs: 2_000 });
  t.after(() => client.close());
  const [slow, fast] = await Promise.all([client.call('slow'), client.call('fast')]);
  assert.deepEqual([slow.value, fast.value], ['slow', 'fast']);
  await assert.rejects(() => client.call('crash'), error => !error.message.includes('SYNTHETIC-PRIVATE-STDERR'));
  assert.ok(client.stderr.includes('SYNTHETIC-PRIVATE-STDERR'));
});

test('stdio client refuses non-JSON stdout and enforces a bounded call timeout', async t => {
  const base = ownedTemp(t);
  const noisy = join(base, 'synthetic-noisy.mjs');
  const silent = join(base, 'synthetic-silent.mjs');
  writeFileSync(noisy, "process.stdin.resume(); process.stdin.once('data', () => process.stdout.write('SYNTHETIC-PRIVATE-NON-JSON\\n'));\n");
  writeFileSync(silent, 'process.stdin.resume();\n');
  const first = await connectMcp({ args: [noisy], initialize: false, timeoutMs: 2_000 });
  t.after(() => first.close());
  await assert.rejects(() => first.call('ping'), error => /invalid JSON-RPC/.test(error.message)
    && !error.message.includes('SYNTHETIC-PRIVATE-NON-JSON'));
  const second = await connectMcp({ args: [silent], initialize: false, timeoutMs: 40 });
  t.after(() => second.close());
  const started = performance.now();
  await assert.rejects(() => second.call('ping'), /client time limit/);
  assert.ok(performance.now() - started < 1_000);
});
