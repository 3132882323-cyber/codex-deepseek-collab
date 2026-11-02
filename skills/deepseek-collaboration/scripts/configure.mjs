#!/usr/bin/env node
// Writes connection metadata only. The API key stays in the caller's environment.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { link, lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const usage = 'Usage: node configure.mjs --base-url HTTPS_URL --model DEEPSEEK_MODEL --credential-source env [--pro-model DEEPSEEK_MODEL] [--state-dir PATH] [--force]';

function reject(message) {
  throw new Error(message);
}

function optionsFrom(argv) {
  const options = {};
  const values = new Map([
    ['--base-url', 'baseUrl'], ['--model', 'model'],
    ['--pro-model', 'proModel'],
    ['--credential-source', 'credentialSource'], ['--state-dir', 'stateDir'],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      if (argv.length !== 1) reject(usage);
      return { help: true };
    }
    if (arg === '--force') {
      if (options.force) reject('Duplicate option.');
      options.force = true;
      continue;
    }
    const name = values.get(arg);
    if (!name || options[name] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      reject('An option is unknown, duplicated, or missing its value.');
    }
    options[name] = argv[++i];
  }
  if (!options.baseUrl || !options.model || options.credentialSource !== 'env') reject(usage);
  options.stateDir = resolve(options.stateDir || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'deepseek-collaboration'));
  return options;
}

function connectionFrom(options) {
  let base;
  try { base = new URL(options.baseUrl); }
  catch { reject('The API base URL is invalid.'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
      || /[?#]/.test(options.baseUrl) || options.baseUrl !== options.baseUrl.trim()) {
    reject('The API base URL must be HTTPS without userinfo, query, or fragment.');
  }
  if (!/^deepseek[A-Za-z0-9._:-]{1,120}$/i.test(options.model)
      || options.proModel !== undefined && !/^deepseek[A-Za-z0-9._:-]{1,120}$/i.test(options.proModel)) {
    reject('The model must be a valid DeepSeek model ID.');
  }
  base.pathname = base.pathname.replace(/\/+$/, '');
  return {
    base_url: base.href.replace(/\/$/, ''),
    allowed_origin: base.origin,
    protocol: 'openai',
    model: options.model,
    models: { flash: options.model, ...(options.proModel ? { pro: options.proModel } : {}) },
    credential_source: 'env',
  };
}

async function configure(options) {
  const connection = connectionFrom(options);
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const state = await lstat(options.stateDir);
  if (!state.isDirectory() || state.isSymbolicLink()) reject('The state directory must be a regular directory.');
  const target = join(options.stateDir, 'connection.json');
  const temporary = join(options.stateDir, `.connection.${randomUUID()}.tmp`);
  try {
    if (!options.force) {
      try { await lstat(target); reject('Configuration already exists; use --force to replace it.'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    await writeFile(temporary, `${JSON.stringify(connection, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (options.force) await rename(temporary, target);
    else await link(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  process.stdout.write('Connection configured. Set DEEPSEEK_API_KEY in the environment before using the client.\n');
}

try {
  const options = optionsFrom(process.argv.slice(2));
  if (options.help) process.stdout.write(`${usage}\n`);
  else await configure(options);
} catch (error) {
  // Do not print native filesystem exceptions or user-supplied arguments.
  const message = error instanceof Error && [
    usage, 'Duplicate option.', 'An option is unknown, duplicated, or missing its value.',
    'The API base URL is invalid.',
    'The API base URL must be HTTPS without userinfo, query, or fragment.',
    'The model must be a valid DeepSeek model ID.',
    'The state directory must be a regular directory.',
    'Configuration already exists; use --force to replace it.',
  ].includes(error.message) ? error.message : 'Configuration could not be written.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
