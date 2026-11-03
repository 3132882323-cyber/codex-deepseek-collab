// CLI integration checks use synthetic state and a child-process fetch stub.
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const client=fileURLToPath(new URL('../skills/deepseek-collaboration/scripts/deepseek-client.mjs',import.meta.url));
const tempRoot=realpathSync(tmpdir());
function fixture(t){
  const root=mkdtempSync(join(tempRoot,'deepseek-cli-capability-'));
  const state=join(root,'state');mkdirSync(state);
  const connection={base_url:'https://api.example.test/v1',allowed_origin:'https://api.example.test',protocol:'openai',
    model:'deepseek-flash-test',models:{flash:'deepseek-flash-test',pro:'deepseek-pro-test'},credential_source:'env',
    default_reasoning_effort:'max',capabilities:{flash:{context_window_tokens:524288,max_output_tokens:278528}}};
  const configPath=join(state,'connection.json');
  const save=()=>writeFileSync(configPath,JSON.stringify(connection));save();
  const prompt=join(root,'prompt.txt');writeFileSync(prompt,'Synthetic task.');
  const capture=join(root,'requests.jsonl');
  const preload=join(root,'fetch-stub.mjs');
  writeFileSync(preload,`import {appendFileSync} from 'node:fs';
globalThis.fetch=async (_url,init)=>{
  const body=JSON.parse(init.body);
  appendFileSync(${JSON.stringify(capture)},JSON.stringify(body)+'\\n');
  const message={content:'Safe answer.',reasoning_content:'SYNTHETIC-PRIVATE-REASONING'};
  if(body.stream){
    const events=[{choices:[{index:0,delta:message,finish_reason:null}]},
      {choices:[{index:0,delta:{},finish_reason:'stop'}]},
      {choices:[],usage:{completion_tokens:24,completion_tokens_details:{reasoning_tokens:18}}}];
    return new Response(events.map(value=>'data: '+JSON.stringify(value)+'\\n\\n').join('')+'data: [DONE]\\n\\n',
      {status:200,headers:{'content-type':'text/event-stream'}});
  }
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message}]}),{status:200,headers:{'content-type':'application/json'}});
};`);
  const run=(args=[],env={})=>spawnSync(process.execPath,['--import',pathToFileURL(preload).href,client,'--state-dir',state,'ask','--prompt-file',prompt,...args],
    {env:{...process.env,CODEX_HOME:root,DEEPSEEK_API_KEY:'SYNTHETIC-CLI-CAPABILITY-ONLY',...env},encoding:'utf8',timeout:10000,maxBuffer:1024*1024,windowsHide:true});
  const requests=()=>existsSync(capture)?readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  t.after(()=>{
    const actual=realpathSync(root),rel=relative(tempRoot,actual);
    assert.ok(rel&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)&&basename(actual).startsWith('deepseek-cli-capability-'));
    rmSync(actual,{recursive:true,force:true});
  });
  return{connection,save,run,requests,prompt,state};
}
function success(result){assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
function failure(result){assert.notEqual(result.status,0);return JSON.parse(result.stderr);}

test('CLI sends configured max reasoning with the ordinary per-task output budget',t=>{
  const ctx=fixture(t);const result=success(ctx.run());
  assert.equal(result.answer,'Safe answer.');
  const [body]=ctx.requests();
  assert.deepEqual(body.thinking,{type:'enabled'});
  assert.equal(body.reasoning_effort,'max');
  assert.equal(body.max_tokens,4096);
  assert.equal(body.stream,false);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC-PRIVATE-REASONING'));
});

test('CLI explicit SSE configuration requests usage and writes safe protocol diagnostics',t=>{
  const ctx=fixture(t);ctx.connection.transport_mode='sse';ctx.save();
  const result=success(ctx.run());
  assert.equal(result.answer,'Safe answer.');
  assert.equal(result.transport_mode,'sse');
  assert.equal(ctx.requests().length,1);
  assert.equal(ctx.requests()[0].stream,true);
  assert.deepEqual(ctx.requests()[0].stream_options,{include_usage:true});
  assert.equal(ctx.requests()[0].reasoning_effort,'max');
  const source=readFileSync(join(ctx.state,'diagnostics.jsonl'),'utf8');
  const entry=JSON.parse(source.trim());
  assert.equal(entry.model,'flash');
  assert.equal(entry.transport_mode,'sse');
  assert.equal(entry.finish_reason,'stop');
  assert.equal(entry.completion_tokens,24);
  assert.equal(entry.reasoning_tokens,18);
  assert.ok(!source.includes('SYNTHETIC-PRIVATE-REASONING'));
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC-PRIVATE-REASONING'));
});

test('CLI SSE dry-run is local metadata and rejects invalid transport configuration before HTTP',t=>{
  const ctx=fixture(t);ctx.connection.transport_mode='sse';ctx.save();
  const result=success(ctx.run(['--dry-run'],{DEEPSEEK_API_KEY:''}));
  assert.equal(result.transport_mode,'sse');
  assert.equal(result.network_used,false);
  assert.equal(ctx.requests().length,0);
  ctx.connection.transport_mode='automatic';ctx.save();
  assert.equal(failure(ctx.run([],{DEEPSEEK_API_KEY:''})).error_code,'configuration_invalid');
  assert.equal(ctx.requests().length,0);
});

test('CLI passes the configured output ceiling and refuses a larger explicit request without replay',t=>{
  const ctx=fixture(t);
  success(ctx.run(['--max-output-tokens','278528']));
  assert.equal(ctx.requests()[0].max_tokens,278528);
  assert.equal(failure(ctx.run(['--max-output-tokens','278529'])).error_code,'invalid_argument');
  assert.equal(ctx.requests().length,1);
});

test('CLI explicit non-thinking overrides a local max default and contradictory flags fail locally',t=>{
  const ctx=fixture(t);
  success(ctx.run(['--thinking','disabled']));
  assert.deepEqual(ctx.requests()[0].thinking,{type:'disabled'});
  assert.equal(ctx.requests()[0].reasoning_effort,undefined);
  assert.equal(failure(ctx.run(['--thinking','disabled','--reasoning-effort','max'])).error_code,'invalid_argument');
  assert.equal(ctx.requests().length,1);
  success(ctx.run(['--reasoning-effort','none']));
  assert.deepEqual(ctx.requests()[1].thinking,{type:'disabled'});
});

test('CLI long-context dry-run expands byte limits only when a context profile is configured',t=>{
  const ctx=fixture(t);writeFileSync(ctx.prompt,'x'.repeat(160*1024));
  const dry=success(ctx.run(['--dry-run'],{DEEPSEEK_API_KEY:''}));
  assert.equal(dry.max_prompt_bytes,2*1024*1024);
  assert.equal(dry.max_response_bytes,16*1024*1024);
  assert.equal(dry.credential_decrypted,false);
  assert.equal(dry.network_used,false);
  delete ctx.connection.capabilities;ctx.save();
  assert.equal(failure(ctx.run(['--dry-run'],{DEEPSEEK_API_KEY:''})).error_code,'prompt_too_large');
  assert.equal(ctx.requests().length,0);
});

test('CLI rejects impossible configured output/context limits before credential use',t=>{
  const ctx=fixture(t);ctx.connection.capabilities.flash.max_output_tokens=524289;ctx.save();
  assert.equal(failure(ctx.run([],{DEEPSEEK_API_KEY:''})).error_code,'configuration_invalid');
  assert.equal(ctx.requests().length,0);
});

test('CLI opted-in long mode uses the route ceiling and longer request budgets without credentials on dry-run',t=>{
  const ctx=fixture(t);ctx.connection.long_task_policy={enabled:true};
  ctx.connection.output_budget_policy={flash:{max_reasoning_min_output_tokens:16384}};ctx.save();
  const out=success(ctx.run(['--dry-run'],{DEEPSEEK_API_KEY:''}));
  assert.equal(out.long_task_mode,true);assert.equal(out.max_output_tokens,278528);
  assert.equal(out.timeout_ms,900000);assert.equal(out.total_timeout_ms,1800000);
  assert.equal(out.credential_decrypted,false);assert.equal(out.network_used,false);assert.equal(ctx.requests().length,0);
  success(ctx.run());assert.equal(ctx.requests()[0].max_tokens,278528);
});

test('CLI long mode honors explicit output and timeout choices while preserving the route cap',t=>{
  const ctx=fixture(t);ctx.connection.long_task_policy={enabled:true};ctx.save();
  const out=success(ctx.run(['--max-output-tokens','32768','--timeout-ms','1200000','--total-timeout-ms','3600000','--dry-run'],{DEEPSEEK_API_KEY:''}));
  assert.equal(out.max_output_tokens,32768);assert.equal(out.timeout_ms,1200000);assert.equal(out.total_timeout_ms,3600000);
  assert.equal(failure(ctx.run(['--max-output-tokens','278529'],{DEEPSEEK_API_KEY:''})).error_code,'invalid_argument');
  assert.equal(ctx.requests().length,0);
});

test('CLI validates long configuration before credentials and does not enable it implicitly',t=>{
  const ctx=fixture(t);
  for(const value of [null,{enabled:'yes'},{enabled:true,extra:'SYNTHETIC-PRIVATE'},{enabled:true,request_timeout_ms:2000,request_total_timeout_ms:1000}]){
    ctx.connection.long_task_policy=value;ctx.save();
    const out=failure(ctx.run([],{DEEPSEEK_API_KEY:''}));assert.equal(out.error_code,'configuration_invalid');
    assert.ok(!JSON.stringify(out).includes('SYNTHETIC-PRIVATE'));
  }
  ctx.connection.long_task_policy={enabled:false};ctx.save();
  assert.equal(failure(ctx.run(['--timeout-ms','900001'],{DEEPSEEK_API_KEY:''})).error_code,'invalid_argument');
  const legacy=success(ctx.run(['--dry-run'],{DEEPSEEK_API_KEY:''}));
  assert.equal(legacy.max_output_tokens,4096);assert.equal(legacy.timeout_ms,180000);assert.equal(legacy.total_timeout_ms,360000);
  assert.equal(ctx.requests().length,0);
});
