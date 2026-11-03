import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { createLongTaskDispatcher } from '../skills/deepseek-collaboration/scripts/deepseek-dispatcher.mjs';

const BUNDLE = fileURLToPath(new URL(
  '../skills/deepseek-collaboration/scripts/vendor/undici-agent.cjs',
  import.meta.url,
));

async function withLoopbackServer(onRequest, run) {
  const timers = new Set();
  const sockets = new Set();
  const schedule = (callback, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, ms);
    timers.add(timer);
  };
  const server = createServer((request, response) => onRequest(request, response, schedule));
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise((accept) => server.close(accept));
  }
}

function dispatchText(dispatcher, origin, path) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    dispatcher.dispatch({
      origin,
      path,
      method: 'GET',
      headersTimeout: 300_000,
      bodyTimeout: 300_000,
    }, {
      onConnect() {},
      onHeaders() { return true; },
      onData(chunk) {
        chunks.push(Buffer.from(chunk));
        return true;
      },
      onComplete() { resolve(Buffer.concat(chunks).toString('utf8')); },
      onError(error) { reject(error); },
    });
  });
}

test('rejects malformed timeouts with one fixed message', () => {
  const messages = new Set();
  for (const value of [0, -1, 1.5, Number.NaN, Infinity, null, 'secret', 86_400_001]) {
    assert.throws(() => createLongTaskDispatcher(value), (error) => {
      assert.ok(error instanceof TypeError);
      messages.add(error.message);
      assert.ok(!error.message.includes('secret'));
      return true;
    });
  }
  assert.equal(messages.size, 1);
  const valid = createLongTaskDispatcher(86_400_000);
  assert.equal(valid.dispose(), undefined);
  assert.equal(valid.dispose(), undefined);
});

test('bundle loads and creates an Agent from an isolated temp directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deepseek-undici-'));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  try {
    await copyFile(BUNDLE, join(directory, 'undici-agent.cjs'));
    const isolatedRequire = createRequire(join(directory, 'probe.cjs'));
    const { Agent } = isolatedRequire('./undici-agent.cjs');
    assert.equal(typeof Agent, 'function');
    const agent = new Agent({ headersTimeout: 100, bodyTimeout: 100, connect: { timeout: 100 } });
    assert.equal(typeof agent.dispatch, 'function');
    await agent.destroy();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native fetch accepts the private dispatcher for JSON and SSE', async () => {
  await withLoopbackServer((request, response, schedule) => {
    if (request.url === '/json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: first\n\n');
    schedule(() => response.end('data: [DONE]\n\n'), 15);
  }, async (origin) => {
    const { dispatcher, dispose } = createLongTaskDispatcher(200);
    try {
      const json = await fetch(origin + '/json', { dispatcher });
      assert.deepEqual(await json.json(), { ok: true });
      const sse = await fetch(origin + '/sse', { dispatcher });
      assert.match(sse.headers.get('content-type'), /text\/event-stream/);
      assert.equal(await sse.text(), 'data: first\n\ndata: [DONE]\n\n');
    } finally {
      dispose();
      dispose();
    }
  });
});

test('dispatch overrides a supplied 300000 ms header timeout', async () => {
  await withLoopbackServer((request, response, schedule) => {
    // Undici uses a roughly 500 ms fast-timer tick for these timeouts. A
    // short configured timeout needs a longer stall to be observable.
    schedule(() => response.end('ok'), request.url === '/slow-head' ? 2_000 : 50);
  }, async (origin) => {
    const generous = createLongTaskDispatcher(200);
    try {
      assert.equal(await dispatchText(generous.dispatcher, origin, '/fast-head'), 'ok');
    } finally {
      generous.dispose();
    }

    const strict = createLongTaskDispatcher(20);
    try {
      await assert.rejects(
        dispatchText(strict.dispatcher, origin, '/slow-head'),
        (error) => error?.code === 'UND_ERR_HEADERS_TIMEOUT',
      );
    } finally {
      strict.dispose();
    }
  });
});

test('dispatch overrides a supplied 300000 ms body timeout', async () => {
  await withLoopbackServer((request, response, schedule) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('a');
    schedule(() => response.end('b'), request.url === '/slow-body' ? 2_000 : 50);
  }, async (origin) => {
    const generous = createLongTaskDispatcher(200);
    try {
      assert.equal(await dispatchText(generous.dispatcher, origin, '/fast-body'), 'ab');
    } finally {
      generous.dispose();
    }

    const strict = createLongTaskDispatcher(20);
    try {
      await assert.rejects(
        dispatchText(strict.dispatcher, origin, '/slow-body'),
        (error) => error?.code === 'UND_ERR_BODY_TIMEOUT',
      );
    } finally {
      strict.dispose();
    }
  });
});

test('dispose is immediate and aborts a stalled fetch body', async () => {
  await withLoopbackServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: first\n\n');
    // Keep the body open until the per-attempt dispatcher is disposed.
  }, async (origin) => {
    const { dispatcher, dispose } = createLongTaskDispatcher(5_000);
    const response = await fetch(origin + '/stalled', { dispatcher });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.match(new TextDecoder().decode(first.value), /first/);

    const pending = reader.read();
    const started = performance.now();
    assert.equal(dispose(), undefined);
    assert.equal(dispose(), undefined);
    assert.ok(performance.now() - started < 500, 'dispose must not wait for a stalled body');

    let timer;
    const settled = await Promise.race([
      pending.then(() => 'resolved', () => 'rejected'),
      new Promise((resolve) => { timer = setTimeout(() => resolve('timed out'), 1_000); }),
    ]);
    clearTimeout(timer);
    assert.notEqual(settled, 'timed out', 'destroy must release the pending body read');
  });
});
