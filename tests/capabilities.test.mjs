// Capability contract tests use synthetic responses and a test-owned state tree.
// An accidental provider call must fail before it can reach the network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createAgentRuntime } from '../skills/deepseek-collaboration/scripts/deepseek-agent-runtime.mjs';
import { getModelCapabilities, loadConfig } from '../skills/deepseek-collaboration/scripts/deepseek-client.mjs';

const KiB = 1024;
const MiB = 1024 * KiB;
const tempRoot = realpathSync(tmpdir());
const credential = 'sk-SYNTHETIC-CAPABILITY-TEST-ONLY';
const reasoningSentinel = 'SYNTHETIC_INTERNAL_REASONING_SENTINEL';
const validPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const models = { flash: 'deepseek-flash-test', pro: 'deepseek-pro-test' };
const plugin = { name: 'lookup_reference', description: 'Synthetic reference lookup.',
  input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } };

const legacyConfig = () => ({
  base_url: 'https://api.example.test/v1', allowed_origin: 'https://api.example.test',
  protocol: 'openai', model: models.flash, models: { ...models }, credential_source: 'env',
});
const profileConfig = () => ({
  ...legacyConfig(),
  default_reasoning_effort: 'max',
  capabilities: {
    flash: { context_window_tokens: 524288, max_output_tokens: 278528,
      vision: { enabled: true, max_images: 4, max_image_bytes: 2 * MiB,
        max_total_image_bytes: 4 * MiB } },
    pro: { context_window_tokens: 524288, max_output_tokens: 278528,
      vision: { enabled: false } },
  },
});

globalThis.fetch = async () => {
  throw new Error('Capability tests forbid real network access.');
};

function completion(content = 'Synthetic answer.', reasoningContent) {
  return { data: { model: models.flash, choices: [{ finish_reason: 'stop',
    message: { role: 'assistant', content,
      ...(reasoningContent === undefined ? {} : { reasoning_content: reasoningContent }) } }] },
  metadata: { attempts: 1, http_status: 200, elapsed_ms: 1 } };
}
function toolResponse(call, reasoningContent) {
  return { data: { model: models.flash, choices: [{ finish_reason: 'tool_calls',
    message: { role: 'assistant', content: null, tool_calls: [call],
      reasoning_content: reasoningContent } }] },
  metadata: { attempts: 1, http_status: 200, elapsed_ms: 1 } };
}
function brokerCall(id = 'synthetic_broker_1') {
  return { id, type: 'function', function: { name: 'codex_tool',
    arguments: JSON.stringify({ name: plugin.name, arguments: { key: 'synthetic' } }) } };
}
function input(extra = {}) {
  return { task: 'Complete a synthetic offline task.', model: 'flash', ...extra };
}
function completed(result) {
  assert.equal(result.state, 'completed', JSON.stringify(result));
  return result;
}
function fixture(t, plan, { config = legacyConfig(), realConfig = false, logger } = {}) {
  const root = mkdtempSync(join(tempRoot, 'codex-capability-test-'));
  const stateDir = join(root, 'state');
  const scratchRoot = join(root, 'scratch');
  mkdirSync(stateDir);
  mkdirSync(scratchRoot);
  if (realConfig) writeFileSync(join(stateDir, 'connection.json'), JSON.stringify(config));
  const calls = [];
  const counters = { credentials: 0 };
  const runtime = createAgentRuntime({
    stateDir, scratchRoot,
    ...(realConfig ? {} : { loadConfig: async () => structuredClone(config) }),
    loadCredential: async () => { counters.credentials += 1; return credential; },
    ...(logger ? { recordDiagnostic: logger } : {}),
    request: async (receivedConfig, endpoint, receivedCredential, body, policy) => {
      assert.equal(receivedConfig.base_url, 'https://api.example.test/v1');
      assert.equal(endpoint, '/chat/completions');
      assert.equal(receivedCredential, credential);
      const index = calls.length;
      calls.push({ body: structuredClone(body), policy: structuredClone(policy) });
      const response = typeof plan === 'function' ? plan(index, body, policy) : plan[index];
      assert.notEqual(response, undefined, 'No unplanned synthetic provider step.');
      return await response;
    },
  });
  t.after(async () => {
    await runtime.dispose();
    const actual = realpathSync(root);
    const scoped = relative(tempRoot, actual);
    assert.ok(actual === resolve(root) && scoped && !isAbsolute(scoped)
      && scoped !== '..' && !scoped.startsWith('..' + sep)
      && basename(actual).startsWith('codex-capability-test-'));
    rmSync(actual, { recursive: true, force: true });
  });
  return { runtime, root, stateDir, scratchRoot, calls, counters };
}
async function refusedBeforeCredential(ctx, args) {
  let result;
  try { result = await ctx.runtime.start(args); }
  catch (error) { assert.equal(typeof error?.code, 'string'); result = { state: 'failed', error_code: error.code }; }
  assert.equal(result.state, 'failed', JSON.stringify(result));
  assert.equal(typeof result.error_code, 'string');
  assert.equal(ctx.counters.credentials, 0);
  assert.equal(ctx.calls.length, 0);
  return result;
}

test('legacy defaults keep 4096 output, disabled thinking, and bounded bytes', async t => {
  const ctx = fixture(t, [completion()]);
  const result = completed(await ctx.runtime.start(input()));
  const body = ctx.calls[0].body;
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(ctx.calls[0].policy.maxResponseBytes, 4 * MiB);
  assert.equal(getModelCapabilities(legacyConfig(), 'flash').max_output_tokens, 8192);
  assert.equal(getModelCapabilities(legacyConfig(), 'flash').max_prompt_bytes, 128 * KiB);
  assert.equal(result.answer, 'Synthetic answer.');
});

test('configured default max enables thinking without allocating the full declared output cap', async t => {
  const ctx = fixture(t, [completion()], { config: profileConfig() });
  completed(await ctx.runtime.start(input()));
  const body = ctx.calls[0].body;
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'max');
  assert.equal(ctx.calls[0].policy.maxResponseBytes, 16 * MiB);
});

test('explicit none overrides configured max and removes reasoning effort from the request', async t => {
  const ctx = fixture(t, [completion()], { config: profileConfig() });
  completed(await ctx.runtime.start(input({ reasoning_effort: 'none' })));
  assert.deepEqual(ctx.calls[0].body.thinking, { type: 'disabled' });
  assert.equal(ctx.calls[0].body.reasoning_effort, undefined);
});

test('configured 278528 output is accepted and forwarded exactly', async t => {
  const ctx = fixture(t, [completion()], { config: profileConfig() });
  completed(await ctx.runtime.start(input({ max_output_tokens: 278528 })));
  assert.equal(ctx.calls[0].body.max_tokens, 278528);
  assert.equal(ctx.calls.length, 1);
});

test('278529 and legacy 8193 output requests stop before credentials or HTTP', async t => {
  const configured = fixture(t, [], { config: profileConfig() });
  await refusedBeforeCredential(configured, input({ max_output_tokens: 278529 }));
  const legacy = fixture(t, []);
  await refusedBeforeCredential(legacy, input({ max_output_tokens: 8193 }));
});

test('large task text requires a configured context window', async t => {
  const largeTask = 'T'.repeat(128 * KiB + 1);
  const configured = fixture(t, [completion()], { config: profileConfig() });
  completed(await configured.runtime.start(input({ task: largeTask })));
  assert.equal(configured.calls[0].body.messages[1].content, largeTask);
  const legacy = fixture(t, []);
  await refusedBeforeCredential(legacy, input({ task: largeTask }));
});

test('large input file requires a configured context window', async t => {
  const file = { path: 'large.txt', content: 'F'.repeat(64 * KiB + 1) };
  const configured = fixture(t, [completion()], { config: profileConfig() });
  completed(await configured.runtime.start(input({ files: [file] })));
  const legacy = fixture(t, []);
  await refusedBeforeCredential(legacy, input({ files: [file] }));
});

test('large final answer is accepted only under the configured context budget', async t => {
  const answer = 'A'.repeat(128 * KiB + 1);
  const configured = fixture(t, [completion(answer)], { config: profileConfig() });
  assert.equal(completed(await configured.runtime.start(input())).answer, answer);
  const legacy = fixture(t, [completion(answer)]);
  const result = await legacy.runtime.start(input());
  assert.equal(result.state, 'failed');
  assert.equal(legacy.calls.length, 1);
});

test('Flash sends an explicit valid PNG as the exact user content block', async t => {
  const ctx = fixture(t, [completion()], { config: profileConfig() });
  completed(await ctx.runtime.start(input({ images: [validPng] })));
  const user = ctx.calls[0].body.messages[1];
  assert.deepEqual(user, { role: 'user', content: [
    { type: 'text', text: 'Complete a synthetic offline task.' },
    { type: 'image_url', image_url: { url: validPng } },
  ] });
});

test('external and filesystem image references are rejected before credentials', async t => {
  for (const url of ['https://example.test/image.png', 'file:///tmp/image.png', '../image.png']) {
    const ctx = fixture(t, [], { config: profileConfig() });
    await refusedBeforeCredential(ctx, input({ images: [url] }));
  }
});

test('malformed base64 and false MIME signatures are rejected before credentials', async t => {
  const pngBase64 = validPng.slice(validPng.indexOf(',') + 1);
  for (const url of ['data:image/png;base64,%%%', 'data:image/jpeg;base64,' + pngBase64,
    'data:image/svg+xml;base64,' + pngBase64]) {
    const ctx = fixture(t, [], { config: profileConfig() });
    await refusedBeforeCredential(ctx, input({ images: [url] }));
  }
});

test('configured image byte limits can be stricter than the runtime hard limit', async t => {
  const config = profileConfig();
  config.capabilities.flash.vision.max_image_bytes = 1;
  const ctx = fixture(t, [], { config });
  await refusedBeforeCredential(ctx, input({ images: [validPng] }));
});

test('Pro image input is denied by default without credentials or HTTP', async t => {
  const ctx = fixture(t, [], { config: profileConfig() });
  await refusedBeforeCredential(ctx, input({ model: 'pro', images: [validPng] }));
});

test('Pro image input requires an explicitly verified capability override', async t => {
  const config = profileConfig();
  config.capabilities.pro.vision = { enabled: true, verified: true };
  const ctx = fixture(t, [completion()], { config });
  completed(await ctx.runtime.start(input({ model: 'pro', images: [validPng] })));
  assert.equal(ctx.calls[0].body.model, models.pro);
  assert.equal(ctx.calls[0].body.messages[1].content[1].image_url.url, validPng);
});

test('tool continuation replays internal reasoning exactly without host or log exposure', async t => {
  const diagnostics = [];
  const ctx = fixture(t, (index, body) => {
    if (index === 0) return toolResponse(brokerCall(), reasoningSentinel);
    assert.equal(index, 1);
    const assistant = body.messages.find(message => message.role === 'assistant');
    assert.equal(assistant.reasoning_content, reasoningSentinel);
    assert.equal(body.messages.at(-1).role, 'tool');
    return completion('Final synthetic answer.', 'SYNTHETIC_SECOND_INTERNAL_SENTINEL');
  }, { config: profileConfig(), logger: async (_state, action, model, result) => {
    diagnostics.push({ action, model, result });
  } });
  const waiting = await ctx.runtime.start(input({ plugin_tools: [plugin] }));
  assert.equal(waiting.state, 'waiting_for_tools');
  assert.equal(waiting.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(waiting), /SYNTHETIC_INTERNAL_REASONING_SENTINEL/);
  const finished = completed(await ctx.runtime.resume({ task_id: waiting.task_id,
    results: [{ request_id: waiting.requests[0].request_id, result: { value: 'synthetic' } }] }));
  assert.equal(finished.answer, 'Final synthetic answer.');
  assert.equal(ctx.calls.length, 2);
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(diagnostics.map(item => item.action), ['agent_step', 'agent_step']);
  assert.doesNotMatch(JSON.stringify([waiting, finished, diagnostics]),
    /SYNTHETIC_(?:SECOND_)?INTERNAL_REASONING_SENTINEL/);
});

test('real loadConfig accepts the profile and rejects malformed capability schemas locally', async t => {
  const config = profileConfig();
  const ctx = fixture(t, [completion()], { config, realConfig: true });
  const loaded = await loadConfig(ctx.stateDir);
  assert.equal(loaded.default_reasoning_effort, 'max');
  assert.equal(getModelCapabilities(loaded, 'flash').max_output_tokens, 278528);
  completed(await ctx.runtime.start(input()));
  assert.equal(ctx.calls.length, 1);

  for (const mutation of [
    value => { value.capabilities.unknown = {}; },
    value => { value.capabilities.flash.max_output_tokens = 524289; },
    value => { value.capabilities.pro.vision = { enabled: true }; },
    value => { value.default_reasoning_effort = 'ultra'; },
  ]) {
    const invalid = profileConfig();
    mutation(invalid);
    writeFileSync(join(ctx.stateDir, 'connection.json'), JSON.stringify(invalid));
    await assert.rejects(() => loadConfig(ctx.stateDir), { code: 'configuration_invalid' });
    const beforeCalls = ctx.calls.length;
    const beforeCredentials = ctx.counters.credentials;
    const result = await ctx.runtime.start(input());
    assert.equal(result.state, 'failed');
    assert.equal(ctx.calls.length, beforeCalls);
    assert.equal(ctx.counters.credentials, beforeCredentials);
  }
  assert.equal(readFileSync(join(ctx.stateDir, 'connection.json'), 'utf8').includes(credential), false);
});
