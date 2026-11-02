#!/usr/bin/env node
// Offline black-box reliability/security tests. Never opens the user's credential.
// Every provider response and DPAPI operation is synthetic; client subprocesses
// and alternative networking transports are denied by the preload below.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = join(project, 'skills', 'deepseek-collaboration', 'scripts');
const helper = join(scripts, 'deepseek-client.mjs');
const setup = join(scripts, 'configure.mjs');
const key = 'sk-SYNTHETIC-OFFLINE-KEY-DO-NOT-USE';
const prompt = 'SYNTHETIC PRIVATE QUESTION CONTENT';
const answer = 'SYNTHETIC PRIVATE FINAL ANSWER';
const reasoning = 'SYNTHETIC PRIVATE REASONING';
const model = 'deepseek-test-fixture';
const rawFailure = 'SYNTHETIC UNSAFE RAW FAILURE';
const config = { base_url:'https://api.example.test/v1', allowed_origin:'https://api.example.test',
  protocol:'openai', model, models:{flash:model}, credential_source:'dpapi' };

if (!existsSync(helper)) {
  process.stderr.write('Reliability implementation not yet present.\n');
  process.exit(3);
}

const temporaryRoot = realpathSync(tmpdir());
const base = mkdtempSync(join(temporaryRoot, 'codex-deepseek-offline-'));
const preload = join(base, 'preload.cjs');
writeFileSync(preload, String.raw`
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const cp = require('node:child_process');
const mod = require('node:module');
const path = require('node:path');
const originalAppend = fs.appendFileSync.bind(fs);
const record = event => {
  // Event files retain only placeholder values, including assertion failures.
  let serialized = JSON.stringify({time:Date.now(),...event});
  for (const [value, placeholder] of [[process.env.TEST_KEY,'[TEST_KEY]'],
    [process.env.TEST_PROMPT,'[TEST_PROMPT]'],[process.env.TEST_ANSWER,'[TEST_ANSWER]'],
    [process.env.TEST_REASONING,'[TEST_REASONING]'],[process.env.TEST_RAW_FAILURE,'[TEST_FAILURE]'],
    [process.env.DEEPSEEK_API_KEY,'[ENV_KEY]']]) {
    if (value) serialized = serialized.split(value).join(placeholder);
  }
  originalAppend(process.env.TEST_EVENTS, serialized+'\n');
};
const deny = kind => { record({kind}); throw new Error('Offline test blocked '+kind); };
const key = process.env.TEST_KEY;
const plan = JSON.parse(process.env.TEST_PLAN);
if (process.env.TEST_PLATFORM) Object.defineProperty(process, 'platform', {value:process.env.TEST_PLATFORM});
const prompt = process.env.TEST_PROMPT;
const answer = process.env.TEST_ANSWER;
const reasoning = process.env.TEST_REASONING;
const unsafe = process.env.TEST_RAW_FAILURE+' '+key+' '+prompt;
const root = path.resolve(process.env.TEST_CASE_DIR).toLowerCase()+path.sep;
function guardCredentialRead(file) {
  if (typeof file !== 'string' && !(file instanceof URL) && !Buffer.isBuffer(file)) return;
  const value = file instanceof URL ? require('node:url').fileURLToPath(file) : String(file);
  if (/(?:credential\.dpapi|connection\.json)$/i.test(value) &&
      !path.resolve(value).toLowerCase().startsWith(root)) deny('real_state_read');
  if (/credential\.dpapi$/i.test(value)) record({kind:'credential_read'});
}
for (const name of ['readFileSync','openSync']) {
  const original = fs[name].bind(fs);
  fs[name] = (file,...args) => { guardCredentialRead(file); return original(file,...args); };
}
for (const name of ['readFile','open']) {
  const original = fs[name].bind(fs);
  fs[name] = (file,...args) => { guardCredentialRead(file); return original(file,...args); };
  const originalPromise = fsp[name].bind(fsp);
  fsp[name] = (file,...args) => { guardCredentialRead(file); return originalPromise(file,...args); };
}
cp.execFileSync = (file,args,options) => {
  record({kind:'decrypt', file:String(file), stdin_only:options?.input === 'SYNTHETIC-DPAPI-ENVELOPE',
    secret_in_arguments:JSON.stringify(args).includes(key)});
  if (String(file).toLowerCase() !== 'pwsh.exe') return deny('unexpected_decrypt_subprocess');
  if (plan.decryptError) {
    const error = new Error(unsafe);
    error.stderr = Buffer.from(unsafe);
    throw error;
  }
  return key;
};
for (const name of ['execSync','spawnSync','exec','execFile','spawn','fork']) cp[name] = () => deny('subprocess:'+name);
for (const name of ['node:http','node:https','node:http2','node:net','node:tls','node:dgram','node:dns']) {
  const target = require(name);
  for (const method of ['request','get','connect','createConnection','createSocket','lookup','resolve']) {
    if (typeof target[method] === 'function') target[method] = () => deny(name+':'+method);
  }
}
require('node:net').Socket.prototype.connect = () => deny('node:net:Socket.connect');
if (plan.freezeClock) {
  Object.defineProperty(require('node:perf_hooks').performance, 'now', {configurable:true,value:()=>0});
}
if (plan.random !== undefined) Math.random = () => plan.random;
mod.syncBuiltinESMExports();

function aborted(signal) {
  // A live mock timer keeps the process around until the native AbortSignal
  // deadline fires. This timer never performs networking or subprocess work.
  return new Promise((_,reject) => {
    const hold = setTimeout(() => reject(new Error('Mock signal was never aborted')), 4000);
    const finish = () => {
      clearTimeout(hold);
      record({kind:'abort_observed'});
      const error = new Error(unsafe);
      error.name = 'AbortError';
      reject(error);
    };
    if (!signal) { clearTimeout(hold); return reject(new Error('Missing abort signal')); }
    if (signal.aborted) return finish();
    signal.addEventListener('abort', finish, {once:true});
  });
}
function failureBody() {
  return {cancel:async()=>record({kind:'body_cancel'}),getReader:()=>deny('error_body_read')};
}
let requests = 0;
globalThis.fetch = async (url,options={}) => {
  const index = requests++;
  const step = plan.steps[Math.min(index,plan.steps.length-1)] || {kind:'success'};
  record({kind:'fetch',index,url:String(url),method:options.method,redirect:options.redirect,
    headers:options.headers,body:options.body});
  if (step.kind === 'timeout') return await aborted(options.signal);
  if (step.kind === 'transport') {
    const error = new TypeError(unsafe);
    error.code = step.code || 'UNSAFE_'+key;
    error.cause = {message:unsafe,code:step.causeCode || 'UNSAFE_'+key};
    throw error;
  }
  const headers = new Headers({'content-type':'application/json'});
  headers.set(step.requestIdHeader || 'x-request-id',step.requestId || 'req-offline-123');
  if (step.retryAfter !== undefined) headers.set('retry-after',String(step.retryAfter));
  if (step.kind === 'late_fetch') {
    await new Promise(resolve=>setTimeout(resolve,80));
    record({kind:'late_fetch_completed',aborted:options.signal?.aborted===true});
    return {ok:true,status:200,headers,body:{
      cancel:async()=>record({kind:'late_body_cancel'}),
      getReader:()=>deny('late_body_read'),
    }};
  }
  if (step.kind === 'oversize_header') {
    headers.set('content-length',String(4*1024*1024+1));
    return {ok:true,status:200,headers,body:{
      cancel:()=>{record({kind:'body_cancel'});return new Promise(()=>{});},
      getReader:()=>deny('oversize_body_read'),
    }};
  }
  if (step.kind === 'oversize_stream') return {ok:true,status:200,headers,body:{
    cancel:()=>{record({kind:'body_cancel'});return new Promise(()=>{});},
    getReader:()=>({
      read:async()=>({done:false,value:new Uint8Array(4*1024*1024+1)}),
      cancel:()=>{record({kind:'reader_cancel'});return new Promise(()=>{});},
      releaseLock:()=>record({kind:'reader_release'}),
    }),
  }};
  if (step.kind === 'http') return {
    ok:false,status:step.status,headers,body:failureBody(),
    text:()=>deny('error_body_read'),json:()=>deny('error_body_read'),arrayBuffer:()=>deny('error_body_read'),
  };
  if (step.kind === 'body_timeout') return {
    ok:true,status:200,headers,
    body:{getReader:()=>({read:()=>aborted(options.signal),cancel:async()=>{},releaseLock:()=>{}})},
  };
  if (step.kind === 'body_ignores_abort') return {
    ok:true,status:200,headers,
    body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{}),releaseLock:()=>{}})},
  };
  if (step.kind === 'body_disconnect') return {
    ok:true,status:200,headers,
    body:{getReader:()=>({read:async()=>{throw new Error(unsafe)},cancel:async()=>{},releaseLock:()=>{}})},
  };
  if (step.kind === 'invalid_json') return new Response('{"choices":[{"message":', {status:200,headers});
  if (step.kind === 'invalid_utf8') return new Response(new Uint8Array([0xff,0xfe,0xfd]),{status:200,headers});
  if (step.kind === 'models') return new Response(JSON.stringify({data:[{id:'deepseek-test-fixture'}]}),{status:200,headers});
  const content = step.content !== undefined ? step.content : answer;
  const payload = {model:step.reportedModel || 'deepseek-test-fixture',choices:[{
    message:{role:'assistant',content,reasoning_content:reasoning},
    finish_reason:step.finishReason === undefined ? 'stop' : step.finishReason}],
    usage:step.usage || {prompt_tokens:4,completion_tokens:5,total_tokens:9}};
  return new Response(JSON.stringify(payload),{status:200,headers});
};
`, 'utf8');

let passed = 0;
let skipped = 0;
const tests = [];
function check(name,fn) { tests.push([name,fn]); }
function state(name, changes={}) {
  const dir = join(base,name);
  mkdirSync(dir);
  const stateDir = join(dir,'state');
  mkdirSync(stateDir);
  const promptFile = join(dir,'prompt.txt');
  const configuration = join(stateDir,'connection.json');
  const credential = join(stateDir,'credential.dpapi');
  writeFileSync(configuration,JSON.stringify({...config,...changes}));
  writeFileSync(credential,'SYNTHETIC-DPAPI-ENVELOPE');
  writeFileSync(promptFile,prompt);
  return {dir,stateDir,promptFile,configuration,credential,
    log:join(stateDir,'diagnostics.jsonl'),previousLog:join(stateDir,'diagnostics.previous.jsonl')};
}
function run(ctx,steps,args,plan={},target=helper) {
  const {environment={},platform='win32',expectJson=true,...mockPlan}=plan;
  const eventsFile = join(ctx.dir,'events-'+Math.random().toString(36).slice(2)+'.jsonl');
  const env = {
    SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:process.env.PATH,
    USERPROFILE:ctx.dir,HOME:ctx.dir,CODEX_HOME:ctx.dir,TEMP:ctx.dir,TMP:ctx.dir,
    TEST_EVENTS:eventsFile,TEST_CASE_DIR:ctx.dir,TEST_PLAN:JSON.stringify({steps,...mockPlan}),TEST_PLATFORM:platform,
    TEST_KEY:key,TEST_PROMPT:prompt,TEST_ANSWER:answer,TEST_REASONING:reasoning,TEST_RAW_FAILURE:rawFailure,
    ...environment,
  };
  const result = spawnSync(process.execPath,['--require',preload,target,'--state-dir',ctx.stateDir,...args],
    {env,cwd:ctx.dir,encoding:'utf8',timeout:6000,maxBuffer:2*1024*1024});
  assert.equal(result.error,undefined,`Client process failed: ${result.error?.code || result.error?.message}`);
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  let data;
  if (expectJson) {
    try { data = JSON.parse(stdout || stderr); }
    catch { throw new Error(`Expected one JSON result; exit=${result.status} stdout=${stdout} stderr=${stderr}`); }
  }
  const events = existsSync(eventsFile) ? readFileSync(eventsFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  if (existsSync(eventsFile)) {
    const eventText=readFileSync(eventsFile,'utf8');
    for (const secret of [key,prompt,answer,reasoning,rawFailure]) assert.ok(!eventText.includes(secret),'Test event file leaked a synthetic secret.');
  }
  const log = existsSync(ctx.log) && !requireDirectory(ctx.log) ? readFileSync(ctx.log,'utf8') : '';
  return {code:result.status,stdout,stderr,data,events,log};
}
function requireDirectory(path) {
  // readFileSync throws on directories on Windows; allow logger-failure tests.
  try { readFileSync(path); return false; } catch (error) { if (['EISDIR','EPERM','EACCES'].includes(error.code)) return true; throw error; }
}
function ask(ctx,steps=[{kind:'success'}],extra=[],plan={}) {
  return run(ctx,steps,['ask','--prompt-file',ctx.promptFile,'--max-output-tokens','64',...extra],plan);
}
const fastRetry = ['--max-attempts','3','--retry-base-ms','1','--retry-max-ms','2'];
function fetches(result) { return result.events.filter(event=>event.kind==='fetch'); }
function assertIsolated(result) {
  assert.deepEqual(result.events.filter(event=>event.kind.startsWith('subprocess:') ||
    event.kind.startsWith('node:') || event.kind==='real_state_read' ||
    event.kind==='unexpected_decrypt_subprocess' || event.kind==='error_body_read'),[]);
  for (const event of result.events.filter(event=>event.kind==='decrypt')) {
    assert.equal(event.stdin_only,true);
    assert.equal(event.secret_in_arguments,false);
  }
}
function assertOffline(result) {
  assert.deepEqual(result.events.filter(event=>['decrypt','fetch'].includes(event.kind)),[]);
  assertIsolated(result);
}
function assertNoErrorSecrets(result) {
  for (const secret of [key,prompt,reasoning,rawFailure]) {
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret),`Diagnostic leaked synthetic secret: ${secret}`);
  }
  assertIsolated(result);
}
function assertDiagnosticSafe(result,expectedCount=1) {
  assert.ok(result.log,'Expected one safe diagnostic record.');
  const rows = result.log.trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(rows.length,expectedCount);
  for (const secret of [key,prompt,answer,reasoning,rawFailure]) assert.ok(!result.log.includes(secret),'Diagnostic log contained synthetic private content.');
  const forbidden = new Set(['prompt','prompt_file','answer','body','headers','stack','message','cause','state_dir','output','credential']);
  const visit = value => {
    if (!value || typeof value!=='object') return;
    for (const [name,item] of Object.entries(value)) { assert.ok(!forbidden.has(name),`Unsafe diagnostic field ${name}`); visit(item); }
  };
  for (const row of rows) visit(row);
  return rows;
}
function assertFailed(result,code) {
  assert.notEqual(result.code,0);
  assert.equal(result.data.ok,false);
  if (code) assert.equal(result.data.error_code,code);
  assertNoErrorSecrets(result);
}

check('status is local metadata and creates no diagnostic log',()=>{
  const ctx=state('status');
  const result=run(ctx,[{kind:'transport'}],['status']);
  assert.equal(result.code,0); assert.equal(result.data.ok,true);
  assert.equal(result.data.network_used,false); assert.equal(result.data.credential_decrypted,false);
  assert.equal(existsSync(ctx.log),false); assertOffline(result);
});
check('dry-run shows safe reliability defaults without networking, decrypting, output, or log',()=>{
  const ctx=state('dry-run'); const output=join(ctx.dir,'answer.json');
  const result=run(ctx,[{kind:'transport'}],['ask','--prompt-file',ctx.promptFile,'--dry-run','--output',output]);
  assert.equal(result.code,0); assert.equal(result.data.ok,true);
  assert.equal(result.data.dry_run,true); assert.equal(result.data.timeout_ms,180000);
  assert.equal(result.data.total_timeout_ms,360000); assert.equal(result.data.max_attempts,3);
  assert.equal(result.data.max_output_tokens,4096);
  assert.equal(result.data.network_used,false); assert.equal(result.data.credential_decrypted,false);
  assert.equal(existsSync(output),false); assert.equal(existsSync(ctx.log),false);
  assert.ok(!result.stdout.includes(prompt)); assertOffline(result);
});
check('successful request preserves payload, manual redirects, completion, and safe audit',()=>{
  const ctx=state('success'); const output=join(ctx.dir,'answer.json');
  const result=ask(ctx,[{kind:'success'}],['--output',output]);
  assert.equal(result.code,0); assert.equal(result.data.ok,true); assert.equal(result.data.answer,answer);
  assert.equal(result.data.finish_reason,'stop'); assert.equal(result.data.attempts,1);
  assert.equal(fetches(result).length,1); assert.equal(result.events.filter(e=>e.kind==='decrypt').length,1);
  const request=fetches(result)[0];
  assert.equal(request.url,'https://api.example.test/v1/chat/completions'); assert.equal(request.method,'POST');
  assert.equal(request.redirect,'manual'); assert.equal(request.headers.Authorization,'Bearer [TEST_KEY]');
  assert.deepEqual(JSON.parse(request.body),{model,messages:[{role:'user',content:'[TEST_PROMPT]'}],max_tokens:64,thinking:{type:'disabled'},stream:false});
  assert.equal(JSON.parse(readFileSync(output,'utf8')).ok,true);
  assertDiagnosticSafe(result); assertIsolated(result);
});

for (const status of [300,301,302,303,307,308,400,401,402,403,404,408,409,422]) check(`HTTP ${status} is never retried`,()=>{
  const ctx=state('terminal-http-'+status);
  const result=ask(ctx,[{kind:'http',status}, {kind:'success'}],fastRetry);
  assertFailed(result,'api_http_error'); assert.equal(fetches(result).length,1);
  assert.equal(result.data.attempts,1); assert.equal(result.data.http_status ?? result.data.status,status);
  assertDiagnosticSafe(result);
});
for (const status of [429,500,502,503,504]) check(`HTTP ${status} can recover within an explicit attempt budget`,()=>{
  const ctx=state('recover-http-'+status);
  const result=ask(ctx,[{kind:'http',status},{kind:'success'}],fastRetry);
  assert.equal(result.code,0); assert.equal(result.data.ok,true); assert.equal(result.data.attempts,2);
  assert.equal(fetches(result).length,2); assert.equal(result.data.answer,answer);
  assert.equal(result.events.filter(e=>e.kind==='decrypt').length,1);
  assert.equal(JSON.stringify(fetches(result)[0].body),JSON.stringify(fetches(result)[1].body));
  assertDiagnosticSafe(result); assertIsolated(result);
});
check('retryable failures stop exactly at max-attempts and do not expose error bodies',()=>{
  const ctx=state('retry-exhaustion');
  const result=ask(ctx,[{kind:'http',status:503}],fastRetry);
  assertFailed(result,'api_http_error'); assert.equal(fetches(result).length,3); assert.equal(result.data.attempts,3);
  assertDiagnosticSafe(result);
});
check('max-attempts one disables otherwise retryable HTTP replay',()=>{
  const ctx=state('attempts-one');
  const result=ask(ctx,[{kind:'http',status:429},{kind:'success'}],['--max-attempts','1']);
  assertFailed(result,'api_http_error'); assert.equal(fetches(result).length,1); assert.equal(result.data.attempts,1);
});
check('a terminal HTTP error after a retry stops immediately',()=>{
  const ctx=state('terminal-after-retry');
  const result=ask(ctx,[{kind:'http',status:503},{kind:'http',status:401},{kind:'success'}],fastRetry);
  assertFailed(result,'api_http_error'); assert.equal(fetches(result).length,2);
  assert.equal(result.data.http_status ?? result.data.status,401);
});
for (const kind of ['transport','timeout']) check(`a pre-header ${kind} after HTTP retry cannot inherit stale status or request ID`,()=>{
  const ctx=state('no-stale-metadata-'+kind);
  const result=ask(ctx,[{kind:'http',status:503,requestId:'req-A'},{kind}],
    [...fastRetry,'--timeout-ms','40','--total-timeout-ms','500']);
  assertFailed(result,kind==='timeout'?'request_timeout':'request_failed');
  assert.equal(fetches(result).length,2); assert.equal(result.data.attempts,2);
  assert.equal(result.data.http_status,null); assert.equal(result.data.request_id,null);
  assert.equal(result.data.attempt_history.length,2);
  assert.equal(result.data.attempt_history[0].status,503); assert.equal(result.data.attempt_history[0].request_id,'req-A');
  assert.equal(result.data.attempt_history[1].status,null); assert.equal(result.data.attempt_history[1].request_id,null);
  const [log]=assertDiagnosticSafe(result);
  assert.equal(log.http_status,null); assert.equal(log.request_id,null);
  assert.equal(log.attempt_history[0].request_id,'sha256:'+createHash('sha256').update('req-A').digest('hex').slice(0,16));
  assert.equal(log.attempt_history[1].status,null); assert.equal(log.attempt_history[1].request_id,null);
});
check('a network failure replaces an existing successful output and is still reported on stderr',()=>{
  const ctx=state('failed-output-replaces-success'); const output=join(ctx.dir,'answer.json');
  writeFileSync(output,JSON.stringify({ok:true,answer:'SYNTHETIC PREVIOUS SUCCESS'}));
  const result=ask(ctx,[{kind:'http',status:401}],['--output',output]);
  assertFailed(result,'api_http_error'); assert.equal(result.stdout,''); assert.ok(result.stderr);
  const saved=JSON.parse(readFileSync(output,'utf8'));
  assert.equal(saved.ok,false); assert.equal(saved.error_code,'api_http_error');
  assert.deepEqual(saved,result.data); assertDiagnosticSafe(result);
});
check('Retry-After above the cap stops instead of retrying before the provider cooldown',()=>{
  const ctx=state('retry-cooldown');
  const result=ask(ctx,[{kind:'http',status:429,retryAfter:'60'},{kind:'success'}],fastRetry);
  assertFailed(result,'retry_cooldown'); assert.equal(fetches(result).length,1); assert.equal(result.data.attempts,1);
});
check('Retry-After HTTP date above the cap also stops without replay',()=>{
  const ctx=state('retry-cooldown-date');
  const result=ask(ctx,[{kind:'http',status:503,retryAfter:new Date(Date.now()+60000).toUTCString()},{kind:'success'}],fastRetry);
  assertFailed(result,'retry_cooldown'); assert.equal(fetches(result).length,1);
});
check('an allowed Retry-After is actually honored',()=>{
  const ctx=state('retry-after-honored');
  const result=ask(ctx,[{kind:'http',status:429,retryAfter:'1'},{kind:'success'}],
    ['--max-attempts','2','--retry-base-ms','1','--retry-max-ms','1000','--total-timeout-ms','4000']);
  assert.equal(result.code,0); assert.equal(result.data.ok,true); assert.equal(fetches(result).length,2);
  assert.ok(fetches(result)[1].time-fetches(result)[0].time>=990,'Provider cooldown was bypassed.');
});
check('malformed Retry-After cannot make retry delay unbounded',()=>{
  const ctx=state('retry-after-invalid');
  const result=ask(ctx,[{kind:'http',status:503,retryAfter:'not-a-date'},{kind:'success'}],fastRetry);
  assert.equal(result.code,0); assert.equal(result.data.ok,true); assert.equal(fetches(result).length,2);
});
check('a retry delay equal to the remaining total budget cannot issue another POST',()=>{
  const ctx=state('budget-equal');
  const result=ask(ctx,[{kind:'http',status:503},{kind:'success'}],
    ['--max-attempts','3','--retry-base-ms','100','--retry-max-ms','100','--total-timeout-ms','50'],
    {freezeClock:true,random:0});
  assertFailed(result,'retry_budget_exhausted'); assert.equal(fetches(result).length,1);
});
check('a timeout never replays a possibly processed POST even when attempts remain',()=>{
  const ctx=state('request-timeout');
  const result=ask(ctx,[{kind:'timeout'},{kind:'success'}],
    ['--max-attempts','3','--timeout-ms','40','--total-timeout-ms','1000']);
  assertFailed(result,'request_timeout'); assert.equal(fetches(result).length,1); assert.equal(result.data.attempts,1);
  assert.equal(result.events.filter(e=>e.kind==='abort_observed').length,1); assertDiagnosticSafe(result);
});
check('the total budget also bounds an in-flight first request',()=>{
  const ctx=state('overall-timeout');
  const result=ask(ctx,[{kind:'timeout'},{kind:'success'}],
    ['--max-attempts','3','--timeout-ms','5000','--total-timeout-ms','60']);
  assertFailed(result); assert.equal(fetches(result).length,1);
  assert.equal(result.events.filter(e=>e.kind==='abort_observed').length,1);
  assert.ok(result.data.elapsed_ms<500,'Single attempt ignored the smaller total budget.');
});
check('a network transport exception never replays POST or leaks exception/cause text',()=>{
  const ctx=state('transport-failure');
  const result=ask(ctx,[{kind:'transport'},{kind:'success'}],fastRetry);
  assertFailed(result,'request_failed'); assert.equal(fetches(result).length,1);
  assert.ok(!JSON.stringify(result.data).includes('UNSAFE_')); assertDiagnosticSafe(result);
});
check('only a whitelisted transport errno may be retained',()=>{
  const ctx=state('transport-errno');
  const result=ask(ctx,[{kind:'transport',causeCode:'ECONNRESET'}],fastRetry);
  assertFailed(result,'request_failed'); assert.equal(fetches(result).length,1);
  if (result.data.transport_code!==undefined) assert.equal(result.data.transport_code,'ECONNRESET');
  assert.ok(!JSON.stringify(result.data).includes('UNSAFE_'));
});
check('body timeouts also cannot replay a successful HTTP POST',()=>{
  const ctx=state('body-timeout');
  const result=ask(ctx,[{kind:'body_timeout'},{kind:'success'}],
    ['--max-attempts','3','--timeout-ms','40','--total-timeout-ms','1000']);
  assertFailed(result,'request_timeout'); assert.equal(fetches(result).length,1); assertDiagnosticSafe(result);
});
check('a body reader that ignores abort is still bounded and never replayed',()=>{
  const ctx=state('body-ignores-abort');
  const result=ask(ctx,[{kind:'body_ignores_abort'},{kind:'success'}],
    ['--max-attempts','3','--timeout-ms','20','--total-timeout-ms','80']);
  assertFailed(result,'request_timeout'); assert.equal(fetches(result).length,1); assert.equal(result.data.attempts,1);
  assert.ok(result.data.elapsed_ms<500,'An uncooperative body reader defeated the timeout.');
  assertDiagnosticSafe(result);
});
for (const kind of ['oversize_header','oversize_stream']) check(`${kind} fails promptly even when cancellation never settles`,()=>{
  const ctx=state(kind);
  const result=ask(ctx,[{kind},{kind:'success'}],
    ['--max-attempts','3','--timeout-ms','100','--total-timeout-ms','500']);
  assertFailed(result,'response_too_large'); assert.equal(fetches(result).length,1); assert.equal(result.data.attempts,1);
  assert.equal(result.data.http_status,200);
  assert.ok(!result.events.some(event=>event.kind==='oversize_body_read'));
  if (kind==='oversize_stream') {
    assert.equal(result.events.filter(event=>event.kind==='reader_cancel').length,1);
    assert.equal(result.events.filter(event=>event.kind==='reader_release').length,1);
  } else assert.ok(result.events.some(event=>event.kind==='body_cancel'));
  assertDiagnosticSafe(result);
});
check('a fetch that resolves after its timeout is canceled without reading its late body',()=>{
  const ctx=state('late-fetch');
  const result=ask(ctx,[{kind:'late_fetch'},{kind:'success'}],
    ['--max-attempts','3','--timeout-ms','20','--total-timeout-ms','500']);
  assertFailed(result,'request_timeout'); assert.equal(fetches(result).length,1); assert.equal(result.data.attempts,1);
  const late=result.events.filter(event=>event.kind==='late_fetch_completed');
  assert.equal(late.length,1); assert.equal(late[0].aborted,true);
  assert.ok(!result.events.some(event=>event.kind==='late_body_read'));
  assert.ok(result.events.some(event=>event.kind==='late_body_cancel'));
  assertDiagnosticSafe(result);
});
for (const kind of ['body_disconnect','invalid_json','invalid_utf8']) check(`${kind} after HTTP success is incomplete and never retried`,()=>{
  const ctx=state(kind); const output=join(ctx.dir,'answer.json');
  const result=ask(ctx,[{kind},{kind:'success'}],[...fastRetry,'--output',output]);
  assertFailed(result); assert.equal(fetches(result).length,1);
  if (existsSync(output)) assert.equal(JSON.parse(readFileSync(output,'utf8')).ok,false);
  assertDiagnosticSafe(result);
});
for (const finishReason of ['length','max_tokens','max_output_tokens',null,'tool_calls','content_filter']) check(`finish_reason ${finishReason} cannot produce a success artifact`,()=>{
  const ctx=state('incomplete-'+String(finishReason)); const output=join(ctx.dir,'answer.json');
  const result=ask(ctx,[{kind:'success',finishReason}],[...fastRetry,'--output',output]);
  assertFailed(result,finishReason && ['length','max_tokens','max_output_tokens'].includes(finishReason)?'answer_truncated':'answer_incomplete');
  assert.equal(fetches(result).length,1);
  if (existsSync(output)) assert.equal(JSON.parse(readFileSync(output,'utf8')).ok,false);
  assertDiagnosticSafe(result);
});
check('reasoning alone is never accepted or logged as a final answer',()=>{
  const ctx=state('reasoning-only');
  const result=ask(ctx,[{kind:'success',content:''}],fastRetry);
  assertFailed(result,'empty_answer'); assert.equal(fetches(result).length,1); assertDiagnosticSafe(result);
});
for (const [index,requestId] of [key,'req-'+key,'req '+prompt,'sk-unrelated-synthetic'].entries()) check(`unsafe request ID is suppressed (${requestId===key?'credential':'contaminated '+index})`,()=>{
  const ctx=state('unsafe-request-id-'+index);
  const result=ask(ctx,[{kind:'http',status:401,requestId}],fastRetry);
  assertFailed(result,'api_http_error');
  assert.ok(!JSON.stringify(result.data).includes(requestId));
  assertDiagnosticSafe(result);
});
check('DPAPI failure suppresses subprocess stderr and never makes a request',()=>{
  const ctx=state('decrypt-failure');
  const result=ask(ctx,[{kind:'success'}],[],{decryptError:true});
  assertFailed(result,'credential_decryption_failed'); assert.equal(fetches(result).length,0);
});

for (const protectedName of ['promptFile','configuration','credential','log','previousLog']) check(`output cannot overwrite ${protectedName}`,()=>{
  const ctx=state('output-protected-'+protectedName);
  if (['log','previousLog'].includes(protectedName)) writeFileSync(ctx[protectedName],'SYNTHETIC EXISTING LOG\n');
  const before=readFileSync(ctx[protectedName],'utf8');
  const result=ask(ctx,[{kind:'success'}],['--output',ctx[protectedName]]);
  assertFailed(result,'output_refused'); assert.equal(readFileSync(ctx[protectedName],'utf8'),before); assertOffline(result);
});
check('output through an aliased directory cannot overwrite configuration',()=>{
  const ctx=state('output-alias'); const alias=join(ctx.dir,'state-alias');
  try { symlinkSync(ctx.stateDir,alias,process.platform==='win32'?'junction':'dir'); }
  catch(error) {
    if (['EPERM','EACCES','ENOSYS'].includes(error.code)) { skipped+=1; return; }
    throw error;
  }
  const before=readFileSync(ctx.configuration,'utf8');
  const result=ask(ctx,[{kind:'success'}],['--output',join(alias,'connection.json')]);
  assertFailed(result,'output_refused'); assert.equal(readFileSync(ctx.configuration,'utf8'),before); assertOffline(result);
});
check('output cannot be a hard-link alias of a protected credential',()=>{
  const ctx=state('output-hardlink'); const output=join(ctx.dir,'credential-alias.json');
  try { linkSync(ctx.credential,output); }
  catch(error) {
    if (['EPERM','EACCES','ENOSYS','ENOTSUP'].includes(error.code)) { skipped+=1; return; }
    throw error;
  }
  const before=readFileSync(ctx.credential,'utf8');
  const result=ask(ctx,[{kind:'success'}],['--output',output]);
  assertFailed(result,'output_refused'); assert.equal(readFileSync(ctx.credential,'utf8'),before);
  assert.equal(readFileSync(output,'utf8'),before); assertOffline(result);
});
for (const target of ['log','previousLog']) for (const alias of ['same-path','hardlink']) check(`diagnostic ${target} ${alias} alias cannot append to or rotate a prompt`,()=>{
  const ctx=state('prompt-diagnostic-'+target+'-'+alias);
  if (alias==='same-path') { ctx.promptFile=ctx[target]; writeFileSync(ctx.promptFile,prompt); }
  else {
    try { linkSync(ctx.promptFile,ctx[target]); }
    catch(error) {
      if (['EPERM','EACCES','ENOSYS','ENOTSUP'].includes(error.code)) { skipped+=1; return; }
      throw error;
    }
  }
  const before=readFileSync(ctx.promptFile,'utf8');
  const result=ask(ctx);
  assert.equal(result.code,0); assert.equal(result.data.ok,true); assert.equal(result.data.answer,answer);
  assert.equal(result.data.diagnostic_recorded,false); assert.equal(fetches(result).length,1);
  assert.equal(readFileSync(ctx.promptFile,'utf8'),before); assert.equal(readFileSync(ctx[target],'utf8'),before);
  if (target==='previousLog') assert.equal(existsSync(ctx.log),false);
  assertIsolated(result);
});
check('logger failure preserves a valid successful answer',()=>{
  const ctx=state('log-write-failure'); mkdirSync(ctx.log);
  const result=ask(ctx);
  assert.equal(result.code,0); assert.equal(result.data.ok,true); assert.equal(result.data.answer,answer);
  assert.equal(result.data.diagnostic_recorded,false); assertIsolated(result);
});
check('models uses a safe audit and reports the exact configured model',()=>{
  const ctx=state('models');
  const result=run(ctx,[{kind:'models'}],['models']);
  assert.equal(result.code,0); assert.equal(result.data.ok,true); assert.equal(result.data.configured_model_present,true);
  assert.equal(fetches(result).length,1); assert.equal(fetches(result)[0].method,'GET');
  assertDiagnosticSafe(result); assertIsolated(result);
});
check('models schema validation failure retains the completed network attempt metadata',()=>{
  const ctx=state('models-invalid-response');
  const result=run(ctx,[{kind:'success'}],['models']);
  assertFailed(result,'response_invalid'); assert.equal(fetches(result).length,1);
  assert.equal(result.data.attempts,1); assert.equal(result.data.http_status,200);
  assert.equal(result.data.request_id,'req-offline-123'); assert.equal(result.data.error_category,'response');
  assertDiagnosticSafe(result);
});

for (const header of ['x-request-id','request-id','x-correlation-id']) check(`request ID from ${header} is fingerprinted in diagnostics`,()=>{
  const ctx=state('request-id-header-'+header);
  const result=ask(ctx,[{kind:'success',requestIdHeader:header,requestId:'req-public-fixture'}]);
  assert.equal(result.code,0); assert.equal(result.data.request_id,'req-public-fixture');
  const [row]=assertDiagnosticSafe(result);
  const fingerprint='sha256:'+createHash('sha256').update('req-public-fixture').digest('hex').slice(0,16);
  assert.equal(row.request_id,fingerprint); assert.equal(row.attempt_history[0].request_id,fingerprint);
  assert.ok(!result.log.includes('req-public-fixture'));
});
check('an unrecognized request ID header is omitted from results and diagnostics',()=>{
  const ctx=state('unknown-request-id-header');
  const result=ask(ctx,[{kind:'success',requestIdHeader:'x-unrecognized-request-id',requestId:'req-ignored'}]);
  assert.equal(result.code,0); assert.equal(result.data.request_id,null);
  const [row]=assertDiagnosticSafe(result); assert.equal(row.request_id,null);
  assert.ok(!result.log.includes('req-ignored')); assertIsolated(result);
});

for (const platform of ['win32','linux','']) check(`explicit environment source works without a DPAPI file (${platform || 'native'})`,()=>{
  const ctx=state('env-success-'+(platform || 'native'),{credential_source:'env'});
  rmSync(ctx.credential);
  const result=ask(ctx,[{kind:'success'}],[],{platform,environment:{DEEPSEEK_API_KEY:key}});
  assert.equal(result.code,0); assert.equal(result.data.answer,answer);
  assert.equal(fetches(result).length,1); assert.equal(fetches(result)[0].headers.Authorization,'Bearer [TEST_KEY]');
  assert.ok(!result.events.some(event=>['decrypt','credential_read'].includes(event.kind)));
  assertDiagnosticSafe(result); assertIsolated(result);
});
check('environment source status reports availability without exposing the value',()=>{
  const ctx=state('env-status',{credential_source:'env'});
  const result=run(ctx,[],['status'],{platform:'',environment:{DEEPSEEK_API_KEY:key}});
  assert.equal(result.code,0); assert.equal(result.data.configured,true);
  assert.equal(result.data.credential_storage,'Environment variable DEEPSEEK_API_KEY');
  assert.equal(result.data.credential_source,'env'); assert.equal(result.data.allowed_origin,config.allowed_origin);
  assertNoErrorSecrets(result); assertOffline(result); assert.equal(existsSync(ctx.log),false);
});
check('environment source dry-run succeeds without an environment key or DPAPI access',()=>{
  const ctx=state('env-dry-run',{credential_source:'env'});
  const result=ask(ctx,[],['--dry-run'],{platform:''});
  assert.equal(result.code,0); assert.equal(result.data.dry_run,true);
  assert.ok(!result.events.some(event=>event.kind==='credential_read'));
  assertOffline(result);
});
for (const [label,environment,code] of [
  ['missing',{},'credential_unavailable'],
  ['wrong-variable',{OPENAI_API_KEY:key,DEEPSEEK_TOKEN:key},'credential_unavailable'],
  ['empty',{DEEPSEEK_API_KEY:''},'credential_unavailable'],
  ['whitespace',{DEEPSEEK_API_KEY:' '},'credential_invalid'],
  ['control-character',{DEEPSEEK_API_KEY:'synthetic\nvalue'},'credential_invalid'],
  ['unicode',{DEEPSEEK_API_KEY:'synthetic-密钥'},'credential_invalid'],
  ['oversized',{DEEPSEEK_API_KEY:'x'.repeat(8193)},'credential_invalid'],
]) check(`environment credential ${label} never falls back to an available DPAPI file`,()=>{
  const ctx=state('env-invalid-'+label,{credential_source:'env'});
  const result=ask(ctx,[{kind:'success'}],[],{platform:'',environment});
  assertFailed(result,code); assertOffline(result);
  assert.ok(!result.events.some(event=>event.kind==='credential_read'));
});
check('DPAPI remains the default and ignores an unrelated environment value',()=>{
  const ctx=state('dpapi-default',{credential_source:undefined});
  const result=ask(ctx,[{kind:'success'}],[],{environment:{DEEPSEEK_API_KEY:'invalid environment value'}});
  assert.equal(result.code,0); assert.equal(result.data.answer,answer);
  assert.equal(result.events.filter(event=>event.kind==='decrypt').length,1);
  assert.equal(fetches(result)[0].headers.Authorization,'Bearer [TEST_KEY]'); assertDiagnosticSafe(result);
});
check('missing DPAPI credential cannot fall back to a valid environment key',()=>{
  const ctx=state('dpapi-no-fallback'); rmSync(ctx.credential);
  const result=ask(ctx,[{kind:'success'}],[],{environment:{DEEPSEEK_API_KEY:key}});
  assertFailed(result,'credential_unavailable'); assertOffline(result);
});
check('DPAPI decryption failure cannot fall back to a valid environment key',()=>{
  const ctx=state('dpapi-decrypt-no-fallback');
  const result=ask(ctx,[{kind:'success'}],[],{decryptError:true,environment:{DEEPSEEK_API_KEY:key}});
  assertFailed(result,'credential_decryption_failed'); assert.equal(fetches(result).length,0);
});
check('DPAPI on a non-Windows platform fails before reading a protected credential',()=>{
  const ctx=state('dpapi-platform');
  const result=ask(ctx,[{kind:'success'}],[],{platform:'linux',environment:{DEEPSEEK_API_KEY:key}});
  assertFailed(result,'platform_unsupported'); assertOffline(result);
  assert.ok(!result.events.some(event=>event.kind==='credential_read'));
});

for (const [label,changes] of [
  ['missing-origin',{allowed_origin:undefined}], ['null-origin',{allowed_origin:null}],
  ['array-origin',{allowed_origin:[config.allowed_origin]}],
  ['origin-slash',{allowed_origin:config.allowed_origin+'/'}],
  ['origin-path',{allowed_origin:config.allowed_origin+'/v1'}],
  ['origin-query',{allowed_origin:config.allowed_origin+'?x=1'}],
  ['origin-fragment',{allowed_origin:config.allowed_origin+'#x'}],
  ['origin-userinfo',{allowed_origin:'https://synthetic@api.example.test'}],
  ['origin-http',{allowed_origin:'http://api.example.test'}],
  ['origin-uppercase',{allowed_origin:'https://API.EXAMPLE.TEST'}],
  ['origin-default-port',{allowed_origin:'https://api.example.test:443'}],
  ['origin-suffix',{base_url:'https://api.example.test.unapproved.test/v1'}],
  ['origin-port-mismatch',{base_url:'https://api.example.test:8443/v1'}],
  ['unknown-credential-source',{credential_source:'auto'}],
  ['invalid-credential-source',{credential_source:7}],
]) check(`configuration ${label} is rejected before credential use or networking`,()=>{
  const ctx=state('config-validation-'+label,changes);
  const result=ask(ctx); assertFailed(result); assertOffline(result);
});
check('an explicitly approved HTTPS port and base path are preserved',()=>{
  const ctx=state('approved-custom-port',{base_url:'https://api.example.test:8443/custom/v1/',allowed_origin:'https://api.example.test:8443'});
  const result=ask(ctx); assert.equal(result.code,0);
  assert.equal(fetches(result)[0].url,'https://api.example.test:8443/custom/v1/chat/completions');
  assertDiagnosticSafe(result); assertIsolated(result);
});

for (const [label,prepare,plan,code] of [
  ['invalid-config',ctx=>writeFileSync(ctx.configuration,'{'),{},'configuration_invalid'],
  ['missing-config',ctx=>rmSync(ctx.configuration),{},'configuration_unavailable'],
  ['missing-prompt',ctx=>rmSync(ctx.promptFile),{},'prompt_unavailable'],
  ['empty-prompt',ctx=>writeFileSync(ctx.promptFile,' '),{},'prompt_empty'],
  ['missing-credential',ctx=>rmSync(ctx.credential),{},'credential_unavailable'],
  ['failed-decryption',()=>{},{decryptError:true},'credential_decryption_failed'],
]) check(`local ${label} replaces a previous success artifact with a failure`,()=>{
  const ctx=state('local-failure-output-'+label); const output=join(ctx.dir,'answer.json');
  writeFileSync(output,JSON.stringify({ok:true,answer:'OLD SYNTHETIC SUCCESS'})); prepare(ctx);
  const result=ask(ctx,[{kind:'success'}],['--output',output],plan);
  assertFailed(result,code); assert.equal(fetches(result).length,0);
  assert.deepEqual(JSON.parse(readFileSync(output,'utf8')),result.data);
});

function setupState(name) {
  const ctx=state(name);
  ctx.stateDir=join(ctx.dir,'new-state');
  for (const [name,file] of Object.entries({configuration:'connection.json',credential:'credential.dpapi',
    log:'diagnostics.jsonl',previousLog:'diagnostics.previous.jsonl'})) ctx[name]=join(ctx.stateDir,file);
  return ctx;
}
function configure(ctx,args=[],plan={}) {
  return run(ctx,[],['--base-url',config.base_url,'--model',model,'--credential-source','env',...args],
    {platform:'',expectJson:false,...plan},setup);
}
check('portable setup creates metadata only and pins the chosen HTTPS origin',()=>{
  const ctx=setupState('setup-success');
  const result=configure(ctx,[],{environment:{DEEPSEEK_API_KEY:key}});
  assert.equal(result.code,0); assert.deepEqual(JSON.parse(readFileSync(ctx.configuration,'utf8')),{...config,credential_source:'env'});
  assert.deepEqual(readdirSync(ctx.stateDir),['connection.json']);
  assertNoErrorSecrets(result); assertOffline(result);
  assert.ok(!readFileSync(ctx.configuration,'utf8').includes(key));
  if (process.platform!=='win32') {
    assert.equal(statSync(ctx.stateDir).mode & 0o777,0o700);
    assert.equal(statSync(ctx.configuration).mode & 0o777,0o600);
  }
  const request=ask(ctx,[{kind:'success'}],[],{platform:'',environment:{DEEPSEEK_API_KEY:key}});
  assert.equal(request.code,0); assert.equal(request.data.answer,answer);
  assert.ok(!request.events.some(event=>['decrypt','credential_read'].includes(event.kind)));
});
check('portable setup refuses to overwrite existing metadata without force',()=>{
  const ctx=state('setup-existing'); const before=readFileSync(ctx.configuration,'utf8');
  const result=configure(ctx);
  assert.notEqual(result.code,0); assert.equal(readFileSync(ctx.configuration,'utf8'),before);
  assertNoErrorSecrets(result); assertOffline(result);
  assert.ok(readdirSync(ctx.stateDir).every(name=>!name.endsWith('.tmp')));
});
check('portable setup force atomically replaces metadata without changing a DPAPI file',()=>{
  const ctx=state('setup-force'); const before=readFileSync(ctx.credential,'utf8');
  const result=configure(ctx,['--force']);
  assert.equal(result.code,0); assert.equal(JSON.parse(readFileSync(ctx.configuration,'utf8')).credential_source,'env');
  assert.equal(readFileSync(ctx.credential,'utf8'),before);
  assert.ok(readdirSync(ctx.stateDir).every(name=>!name.endsWith('.tmp'))); assertOffline(result);
});
for (const [label,args] of [
  ['plaintext',['--base-url','http://api.example.test/v1']],
  ['userinfo',['--base-url','https://'+key+'@api.example.test/v1']],
  ['query',['--base-url',config.base_url+'?x=1']],
  ['fragment',['--base-url',config.base_url+'#x']],
  ['invalid-model',['--model','unrelated-model']],
  ['unsupported-source',['--credential-source','dpapi']],
  ['duplicate-force',['--force','--force']],
  ['unknown-option',['--unknown','synthetic']],
]) check(`portable setup rejects ${label} without writing configuration`,()=>{
  const ctx=setupState('setup-invalid-'+label);
  // Replacing the option value tests validation rather than duplicate rejection.
  const defaults=['--base-url',config.base_url,'--model',model,'--credential-source','env'];
  if (args[0]!=='--force' && defaults.includes(args[0])) defaults.splice(defaults.indexOf(args[0]),2);
  const result=run(ctx,[],[...defaults,...args],{platform:'',expectJson:false},setup);
  assert.notEqual(result.code,0); assert.equal(existsSync(ctx.configuration),false);
  assertNoErrorSecrets(result); assertOffline(result);
});
check('portable setup requires an explicit environment source',()=>{
  const ctx=setupState('setup-explicit-env');
  const result=run(ctx,[],['--base-url',config.base_url,'--model',model],{platform:'',expectJson:false},setup);
  assert.notEqual(result.code,0); assert.equal(existsSync(ctx.configuration),false); assertOffline(result);
});

for (const [label,changes] of [
  ['unapproved-origin',{base_url:'https://example.invalid/v1'}],
  ['plaintext-http',{base_url:'http://api.example.test/v1'}],
  ['userinfo',{base_url:'https://synthetic-user@api.example.test/v1'}],
  ['query',{base_url:'https://api.example.test/v1?synthetic=1'}],
  ['hash',{base_url:'https://api.example.test/v1#synthetic'}],
  ['wrong-protocol',{protocol:'anthropic'}],
  ['wrong-model',{model:'claude-synthetic',models:{flash:'claude-synthetic'}}],
]) check(`invalid configuration ${label} is rejected before decryption and network`,()=>{
  const ctx=state('bad-config-'+label); writeFileSync(ctx.configuration,JSON.stringify({...config,...changes}));
  const result=ask(ctx); assertFailed(result); assertOffline(result);
});
check('oversized configuration is rejected locally',()=>{
  const ctx=state('large-config'); writeFileSync(ctx.configuration,' '.repeat(32769));
  const result=ask(ctx); assertFailed(result,'configuration_too_large'); assertOffline(result);
});
check('oversized prompt is rejected locally',()=>{
  const ctx=state('large-prompt'); writeFileSync(ctx.promptFile,'x'.repeat(128*1024+1));
  const result=ask(ctx); assertFailed(result,'prompt_too_large'); assertOffline(result);
});
check('invalid UTF-8 prompt is rejected locally',()=>{
  const ctx=state('invalid-prompt'); writeFileSync(ctx.promptFile,Buffer.from([0xff,0xfe]));
  const result=ask(ctx); assertFailed(result,'prompt_invalid'); assertOffline(result);
});
for (const [label,args] of [
  ['attempts-zero',['--max-attempts','0']],['attempts-four',['--max-attempts','4']],
  ['attempts-fraction',['--max-attempts','1.5']],['timeout-zero',['--timeout-ms','0']],
  ['total-zero',['--total-timeout-ms','0']],['retry-base-zero',['--retry-base-ms','0']],
  ['retry-base-too-large',['--retry-base-ms','10001']],['retry-max-too-large',['--retry-max-ms','60001']],
  ['retry-order',['--retry-base-ms','100','--retry-max-ms','99']],
  ['duplicate-attempts',['--max-attempts','2','--max-attempts','3']],
]) check(`invalid reliability option ${label} is rejected offline`,()=>{
  const ctx=state('invalid-option-'+label); const result=ask(ctx,[{kind:'success'}],args);
  assertFailed(result,'invalid_argument'); assertOffline(result);
});

try {
  for (const [name,fn] of tests) {
    try {
      const previousSkipped=skipped; fn();
      if (skipped>previousSkipped) process.stdout.write('SKIP '+name+' (filesystem links unavailable)\n');
      else { passed+=1; process.stdout.write('PASS '+name+'\n'); }
    } catch(error) {
      process.stderr.write('FAIL '+name+': '+(error.stack || error)+'\n'); process.exitCode=1;
    }
  }
  process.stdout.write(passed+'/'+(tests.length-skipped)+' passed'+(skipped?' ('+skipped+' skipped)':'')+'\n');
} finally {
  // Check the final absolute target before recursive deletion; never follow a
  // computed directory outside this task's explicitly owned temporary area.
  const verified=realpathSync(base);
  if (verified===resolve(base) && verified.startsWith(temporaryRoot+sep) && basename(verified).startsWith('codex-deepseek-offline-')) {
    rmSync(verified,{recursive:true,force:true});
  }
}
