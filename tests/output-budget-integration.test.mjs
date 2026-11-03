// Only synthetic configs and credentials; fetch is replaced in CLI children.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, isAbsolute, sep, basename} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {loadConfig, getOutputBudgetPolicy, recordDiagnostic} from '../skills/deepseek-collaboration/scripts/deepseek-client.mjs';

const tempRoot = realpathSync(tmpdir());
const client = fileURLToPath(new URL('../skills/deepseek-collaboration/scripts/deepseek-client.mjs', import.meta.url));
function config() {
  return {base_url:'https://api.example.test/v1', allowed_origin:'https://api.example.test', protocol:'openai',
    model:'deepseek-flash-synthetic', models:{flash:'deepseek-flash-synthetic'}, credential_source:'env',
    default_reasoning_effort:'max', capabilities:{flash:{max_output_tokens:32768}},
    output_budget_policy:{flash:{max_reasoning_min_output_tokens:16384}}};
}
function fixture(t) {
  const directory = mkdtempSync(join(tempRoot,'deepseek-budget-contract-'));
  const state = join(directory,'state'); mkdirSync(state);
  const prompt = join(directory,'prompt.txt'); writeFileSync(prompt,'Synthetic budget acceptance.');
  const capture = join(directory,'capture.json');
  const hook = join(directory,'network-disabled.mjs');
  writeFileSync(hook, `import {writeFileSync} from 'node:fs';
let calls=0,body;
globalThis.fetch=async(_url,options)=>{calls++;const parsed=JSON.parse(options.body);body={max_tokens:parsed.max_tokens,reasoning_effort:parsed.reasoning_effort};return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Synthetic complete.'}}]}),{status:200,headers:{'content-type':'application/json'}});};
process.on('exit',()=>writeFileSync(process.env.BUDGET_CAPTURE,JSON.stringify({calls,body})));
`);
  t.after(()=>{
    const absolute = realpathSync(directory), scoped = relative(tempRoot,absolute);
    assert.ok(scoped && !isAbsolute(scoped) && scoped !== '..' && !scoped.startsWith('..'+sep)
      && basename(absolute).startsWith('deepseek-budget-contract-'));
    rmSync(absolute,{recursive:true,force:true});
  });
  function save(value) {writeFileSync(join(state,'connection.json'),JSON.stringify(value));}
  function cli(args, key='') {
    const result = spawnSync(process.execPath,['--import',pathToFileURL(hook).href,client,'--state-dir',state,
      'ask','--prompt-file',prompt,...args],{encoding:'utf8',timeout:10000,windowsHide:true,
      env:{...process.env,DEEPSEEK_API_KEY:key,BUDGET_CAPTURE:capture}});
    assert.equal(result.signal,null);
    return {status:result.status, output:JSON.parse((result.stdout||result.stderr).trim()),
      capture:JSON.parse(readFileSync(capture,'utf8'))};
  }
  save(config());
  return {state,save,cli};
}

test('policy is optional, strictly configured, and cannot exceed the route capability', async t=>{
  const ctx=fixture(t), valid=config();
  assert.equal((await loadConfig(ctx.state)).output_budget_policy.flash.max_reasoning_min_output_tokens,16384);
  const legacy=config(); delete legacy.output_budget_policy;
  assert.equal(getOutputBudgetPolicy(legacy,'flash').max_reasoning_min_output_tokens,null);
  const mutations=[
    c=>{c.output_budget_policy=null;}, c=>{c.output_budget_policy=[];},
    c=>{c.output_budget_policy.flash=null;}, c=>{c.output_budget_policy.flash={};},
    c=>{c.output_budget_policy.flash.extra=true;},
    c=>{c.output_budget_policy.flash.max_reasoning_min_output_tokens=null;},
    c=>{c.output_budget_policy.flash.max_reasoning_min_output_tokens='16384';},
    c=>{c.output_budget_policy.flash.max_reasoning_min_output_tokens=16384.5;},
    c=>{c.output_budget_policy.flash.max_reasoning_min_output_tokens=31;},
    c=>{c.output_budget_policy.flash.max_reasoning_min_output_tokens=393217;},
    c=>{c.output_budget_policy.unknown=c.output_budget_policy.flash;},
    c=>{c.output_budget_policy.pro=c.output_budget_policy.flash;},
    c=>{delete c.capabilities;},
  ];
  for(const mutate of mutations){
    const invalid=structuredClone(valid); mutate(invalid); ctx.save(invalid);
    await assert.rejects(()=>loadConfig(ctx.state),{code:'configuration_invalid'});
    assert.throws(()=>getOutputBudgetPolicy(invalid,'flash'),{code:'configuration_invalid'});
  }
});

test('CLI rejects inherited max with default 4096 before credentials or HTTP', t=>{
  const ctx=fixture(t), result=ctx.cli([]);
  assert.notEqual(result.status,0);
  assert.equal(result.output.error_code,'output_budget_insufficient');
  assert.equal(result.capture.calls,0);
});

test('CLI planned max and explicit thinking toggles use their effective settings', t=>{
  const ctx=fixture(t);
  for(const args of [
    ['--reasoning-effort','max','--max-output-tokens','16384','--dry-run'],
    ['--reasoning-effort','none','--max-output-tokens','4096','--dry-run'],
    ['--thinking','disabled','--dry-run'], ['--thinking','enabled','--dry-run'],
  ]){
    const result=ctx.cli(args);
    assert.equal(result.status,0); assert.equal(result.output.credential_decrypted,false);
    assert.equal(result.capture.calls,0);
  }
});

test('first explicitly planned CLI budget is sent unchanged exactly once', t=>{
  const ctx=fixture(t), result=ctx.cli(['--reasoning-effort','max','--max-output-tokens','16384'],
    'SYNTHETIC_BUDGET_CREDENTIAL');
  assert.equal(result.status,0); assert.equal(result.output.ok,true);
  assert.deepEqual(result.capture,{calls:1,body:{max_tokens:16384,reasoning_effort:'max'}});
});

test('new diagnostic metadata remains whitelisted and never reads hostile getters', async t=>{
  const ctx=fixture(t), marker='SYNTHETIC_PRIVATE_SENTINEL';
  const last={step_index:2,completion_tokens:4096,reasoning_tokens:4096,content:marker};
  Object.defineProperty(last,'finish_reason',{get(){throw new Error(marker);}});
  await recordDiagnostic(ctx.state,'agent_task','flash',{ok:false,state:'failed',error_code:'answer_truncated',
    last_response:last,budget_exhaustion:marker,minimum_output_tokens:16384,reasoning_content:marker});
  const raw=readFileSync(join(ctx.state,'diagnostics.jsonl'),'utf8'), entry=JSON.parse(raw);
  assert.equal(entry.last_response.finish_reason,null);
  assert.equal(entry.last_response.completion_tokens,4096);
  assert.equal(entry.budget_exhaustion,null);
  assert.ok(!raw.includes(marker));
});
