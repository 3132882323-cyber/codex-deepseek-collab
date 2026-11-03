// Recovery integration tests use synthetic credentials, input, and network only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep} from 'node:path';
import {request,getRetryPolicy} from '../skills/deepseek-collaboration/scripts/deepseek-client.mjs';
import {createAgentRuntime} from '../skills/deepseek-collaboration/scripts/deepseek-agent-runtime.mjs';
const base={base_url:'https://api.example.test/v1',allowed_origin:'https://api.example.test',protocol:'openai',models:{flash:'deepseek-flash-test'},model:'deepseek-flash-test',credential_source:'env'};
const config={...base,retry_policy:{retry_transient_transport:true}};
const policy={timeoutMs:1000,totalTimeoutMs:5000,maxAttempts:3,retryBaseMs:1,retryMaxMs:1};
const body={model:base.model,messages:[{role:'user',content:'SYNTHETIC-PRIVATE-INPUT'}],stream:true,max_tokens:32768};
const wire=value=>'data: '+JSON.stringify(value)+'\n\n';
const completion=message=>new Response(wire({choices:[{index:0,delta:message,finish_reason:null}]})+wire({choices:[{index:0,delta:{},finish_reason:message.tool_calls?'tool_calls':'stop'}]})+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
const success=()=>completion({content:'Synthetic final.'});
const socket=()=>Object.assign(new TypeError('SYNTHETIC-PRIVATE-ERROR'),{cause:{code:'UND_ERR_SOCKET'}});
globalThis.fetch=async()=>{throw new Error('No real network allowed.');};
test('transport retry config is explicit and validates booleans and known keys',()=>{
  assert.equal(getRetryPolicy(base).retry_transient_transport,false);assert.equal(getRetryPolicy(config).retry_transient_transport,true);
  for(const value of [null,[],{},true,{retry_transient_transport:1},{retry_transient_transport:true,other:true}])assert.throws(()=>getRetryPolicy({...base,retry_policy:value}),e=>e.code==='configuration_invalid');
});
test('opt-in socket retry uses the identical payload and the shared attempt budget',async t=>{
  const payloads=[];t.mock.method(globalThis,'fetch',async(_url,init)=>{payloads.push(init.body);if(payloads.length<3)throw socket();return success();});
  const out=await request(config,'/chat/completions','SYNTHETIC-KEY',body,policy);
  assert.equal(out.metadata.attempts,3);assert.equal(new Set(payloads).size,1);assert.equal(out.metadata.attempt_history.length,3);
  assert.deepEqual(out.metadata.attempt_history.map(x=>x.category),['transport','transport','ok']);
});
test('HTTP status and socket failures together never exceed three total attempts',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;if(calls===2)throw socket();return new Response('',{status:calls===1?429:500});});
  await assert.rejects(request(config,'/chat/completions','SYNTHETIC-KEY',body,policy),e=>e.code==='api_http_error'&&e.metadata.attempts===3&&e.metadata.attempt_history.length===3);
  assert.equal(calls,3);
});
test('default policy and unknown/TLS failures do not replay',async t=>{
  let calls=0;let error=socket();t.mock.method(globalThis,'fetch',async()=>{calls++;throw error;});
  await assert.rejects(request(base,'/chat/completions','SYNTHETIC-KEY',body,policy));assert.equal(calls,1);
  for(const code of [null,'ENOTFOUND','CERT_HAS_EXPIRED']){calls=0;error=Object.assign(new Error('private'),code?{code}:{});await assert.rejects(request(config,'/chat/completions','SYNTHETIC-KEY',body,policy));assert.equal(calls,1);}
});
test('semantic SSE damage, clean incomplete EOF, and output truncation are never transport retries',async t=>{
  let calls=0;let response;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return response;});
  for(const raw of ['data: {bad\n\n',wire({choices:[{index:0,delta:{content:'unfinished'},finish_reason:null}]}),wire({choices:[{index:0,delta:{content:'truncated'},finish_reason:'length'}]})+'data: [DONE]\n\n']){
    calls=0;response=new Response(raw,{headers:{'content-type':'text/event-stream'}});
    try{const result=await request(config,'/chat/completions','SYNTHETIC-KEY',body,policy);assert.equal(result.data.choices[0].finish_reason,'length');}catch(e){assert.equal(e.code,'response_invalid');}
    assert.equal(calls,1);
  }
});
test('an explicit local timeout can retry while its late response stays uncommitted',async t=>{
  let release;let calls=0;let firstSignal;
  t.mock.method(globalThis,'fetch',async(_u,init)=>{calls++;if(calls===1){firstSignal=init.signal;return await new Promise(yes=>{release=yes;});}return success();});
  const out=await request(config,'/chat/completions','SYNTHETIC-KEY',body,{...policy,timeoutMs:15});
  assert.equal(calls,2);assert.equal(firstSignal.aborted,true);assert.equal(out.metadata.http_status,200);assert.equal(out.metadata.attempt_history[0].category,'timeout');
  release(new Response('',{status:503}));await new Promise(yes=>setTimeout(yes,0));assert.equal(calls,2);assert.equal(out.metadata.http_status,200);
});
test('cancelling an HTTP200 hanging body stops promptly and never retries',async t=>{
  const controller=new AbortController();let entered;let calls=0;let fetchSignal;
  const begun=new Promise(yes=>{entered=yes;});
  t.mock.method(globalThis,'fetch',async(_u,init)=>{calls++;fetchSignal=init.signal;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(': keep-alive\n\n'));entered();}}),{headers:{'content-type':'text/event-stream'}});});
  const running=request(config,'/chat/completions','SYNTHETIC-KEY',body,policy,{signal:controller.signal});
  await begun;controller.abort();
  await assert.rejects(Promise.race([running,new Promise((_,no)=>{const timer=setTimeout(()=>no(new Error('cancel blocked')),200);timer.unref();})]),e=>e.code==='request_cancelled');
  assert.equal(calls,1);assert.equal(fetchSignal.aborted,true);
});
test('remaining time and one remaining attempt prevent transport replay',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw socket();});
  for(const extra of [{maxAttempts:1},{totalTimeoutMs:1}]){calls=0;await assert.rejects(request(config,'/chat/completions','SYNTHETIC-KEY',body,{...policy,...extra}));assert.equal(calls,1);}
});
test('cancelling transport backoff preserves both attempts and stops the third POST',async t=>{
  const controller=new AbortController();let calls=0;let listeners=0;
  const add=controller.signal.addEventListener.bind(controller.signal);
  t.mock.method(controller.signal,'addEventListener',(...args)=>{add(...args);if(++listeners===4)queueMicrotask(()=>controller.abort());});
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw socket();});
  await assert.rejects(request(config,'/chat/completions','SYNTHETIC-KEY',body,{...policy,retryBaseMs:10,retryMaxMs:10},{signal:controller.signal}),e=>{
    assert.equal(e.code,'request_cancelled');assert.equal(e.metadata.attempts,2);
    assert.equal(e.metadata.error_category,'cancelled');assert.equal(e.metadata.attempt_history.length,2);return true;
  });
  assert.equal(calls,2);
});
test('a broken first tool stream never executes its partial call; the successful step writes once',async t=>{
  const tempRoot=realpathSync(tmpdir());const state=await mkdtemp(join(tempRoot,'deepseek-recovery-integration-'));
  t.after(async()=>{const r=relative(tempRoot,state);assert.ok(r&&!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));await rm(state,{recursive:true,force:true});});
  const capConfig={...config,transport_mode:'sse',default_reasoning_effort:'max',capabilities:{flash:{context_window_tokens:524288,max_output_tokens:278528}}};
  const args={path:'checkpoint.txt',content:'written-once'};
  const call={index:0,id:'call_once',type:'function',function:{name:'write_file',arguments:JSON.stringify(args)}};
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{
    calls++;
    if(calls===1)return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(wire({choices:[{index:0,delta:{tool_calls:[{...call,function:{name:'write_file',arguments:'{"path":'}}]},finish_reason:null}]})));queueMicrotask(()=>c.error(socket()));}}),{headers:{'content-type':'text/event-stream'}});
    return calls===2?completion({content:null,tool_calls:[call]}):success();
  });
  const runtime=createAgentRuntime({stateDir:state,scratchRoot:join(state,'scratch'),loadConfig:async()=>capConfig,loadCredential:async()=>'SYNTHETIC-KEY',request,recordDiagnostic:async()=>{}});t.after(()=>runtime.dispose());
  const out=await runtime.start({task:'Write checkpoint.txt once, then finish.',model:'flash',reasoning_effort:'max',max_output_tokens:32768,max_steps:3});
  assert.equal(out.state,'completed');assert.equal(out.steps,2);assert.equal(out.http_attempts,3);assert.equal(out.tool_calls,1);assert.equal(out.artifacts.length,1);assert.equal(out.artifacts[0].content,'written-once');
});
