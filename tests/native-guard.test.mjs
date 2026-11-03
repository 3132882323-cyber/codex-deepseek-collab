import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeServer,forwardNative,encodeCompletedResponse} from '../skills/deepseek-collaboration/scripts/deepseek-native.mjs';
import {validateResponsesJson,validateResponsesSse} from '../skills/deepseek-collaboration/scripts/deepseek-native-core.mjs';
import {captureDesktopChange,restoreDesktopEdits} from '../skills/deepseek-collaboration/scripts/deepseek-native-desktop.mjs';
import {safeTransportCode} from '../skills/deepseek-collaboration/scripts/deepseek-client.mjs';

const settings={version:1,model:'deepseek-flash-test',port:47830,connection_state_dir:'synthetic-state',planned_output_tokens:32768};
const config={base_url:'https://api.example.test/v1',allowed_origin:'https://api.example.test',models:{flash:settings.model},capabilities:{flash:{context_window_tokens:524288,max_output_tokens:278528}},output_budget_policy:{flash:{max_reasoning_min_output_tokens:16384}}};
const body=()=>({model:settings.model,store:false,stream:true,input:'Synthetic user task',reasoning:{effort:'max'}});
const result=()=>({id:'resp_test',object:'response',status:'completed',output:[{type:'message',id:'msg_test',status:'completed',role:'assistant',content:[{type:'output_text',text:'Synthetic completed answer',annotations:[]}]}]});
const event=(type,extra={})=>`event: ${type}\ndata: ${JSON.stringify({type,...extra})}\n\n`;
const okResponse=()=>new Response(encodeCompletedResponse(result()),{headers:{'content-type':'text/event-stream'}});
function dependencies(fetchImpl){let keys=0;return{deps:{configLoader:async()=>config,credentialLoader:async()=>{keys++;return'SYNTHETIC-KEY-ONLY';},fetchImpl},keys:()=>keys};}

test('native preflight rejects invalid budgets, non-max, Pro and bad routes before key/HTTP',async()=>{
  let posts=0;const d=dependencies(async()=>{posts++;return okResponse();});
  for(const update of [{max_output_tokens:4096},{reasoning:{effort:'high'}},{model:'deepseek-pro-test'},{previous_response_id:'remote'},{store:true},{max_output_tokens:999999}]){
    await assert.rejects(forwardNative({...body(),...update},settings,d.deps));
  }
  assert.equal(d.keys(),0);assert.equal(posts,0);
});
test('native transport sends explicit planned max budget, exact Flash and approved origin',async()=>{
  let sent;const d=dependencies(async(url,init)=>{sent={url:String(url),...init,body:JSON.parse(init.body)};return okResponse();});
  const out=await forwardNative(body(),settings,d.deps);
  assert.equal(out.attempts,1);assert.equal(sent.body.max_output_tokens,32768);assert.equal(sent.body.reasoning.effort,'max');assert.equal(sent.body.model,settings.model);
  assert.equal(sent.url,'https://api.example.test/v1/responses');assert.equal(sent.redirect,'manual');assert.ok(!out.raw.includes('SYNTHETIC-KEY-ONLY'));
});
test('existing valid budget is preserved and no caller input is mutated',async()=>{
  const input={...body(),max_output_tokens:16384};const snapshot=structuredClone(input);let budget;
  const d=dependencies(async(_u,init)=>{budget=JSON.parse(init.body).max_output_tokens;return okResponse();});
  await forwardNative(input,settings,d.deps);assert.equal(budget,16384);assert.deepEqual(input,snapshot);
});
test('native transport retries only an explicit allowed status',async()=>{
  let calls=0;const d=dependencies(async()=>++calls===1?new Response('',{status:503,headers:{'retry-after':'0'}}):okResponse());
  const out=await forwardNative(body(),settings,d.deps);assert.equal(calls,2);assert.equal(out.attempts,2);
});
for(const [name,produce,expected] of [
  ['transport',()=>{throw new TypeError('SYNTHETIC-PRIVATE-ERROR',{cause:{code:'UND_ERR_SOCKET'}});},502],
  ['truncated SSE',()=>new Response(event('response.created')+event('response.incomplete',{response:{...result(),status:'incomplete'}}),{headers:{'content-type':'text/event-stream'}}),502],
  ['broken JSON',()=>new Response('{',{headers:{'content-type':'application/json'}}),502],
  ['authentication',()=>new Response('',{status:401}),400],
  ['unknown HTTP',()=>new Response('',{status:599}),599],
  ['long Retry-After',()=>new Response('',{status:429,headers:{'retry-after':'999'}}),429]
])test(`native ${name} stops without replay`,async()=>{
  let calls=0;const d=dependencies(async()=>{calls++;return produce();});
  await assert.rejects(forwardNative(body(),settings,d.deps),e=>e.status===expected&&!e.message.includes('SYNTHETIC-PRIVATE-ERROR')&&(name!=='transport'||safeTransportCode(e)==='UND_ERR_SOCKET'));
  assert.equal(calls,1);
});
test('cancel while an allowed status returns prevents a subsequent POST',async()=>{
  const cancel=new AbortController();let calls=0;const d=dependencies(async()=>{calls++;cancel.abort();return new Response('',{status:503});});
  await assert.rejects(forwardNative(body(),settings,{...d.deps,signal:cancel.signal}),e=>e.code==='cancelled');assert.equal(calls,1);
});
test('canonical events contain only validated terminal tools, never an intermediate injected tool',async()=>{
  const extra={type:'function_call',id:'extra',call_id:'call_extra',name:'untrusted_extra',arguments:'{"broken":'};
  const raw=event('response.created')+event('response.output_item.done',{output_index:0,item:extra})+event('response.completed',{response:result()});
  const d=dependencies(async()=>new Response(raw,{headers:{'content-type':'text/event-stream'}}));
  const out=await forwardNative(body(),settings,d.deps);
  assert.ok(!out.raw.includes('untrusted_extra'));assert.equal(validateResponsesSse(out.raw).response.output.length,1);
});
test('terminal duplicate tool call IDs and duplicate output item IDs are refused',()=>{
  const call={type:'function_call',id:'a',call_id:'same',name:'synthetic',arguments:'{}'};
  assert.throws(()=>validateResponsesJson({...result(),output:[call,{...call,id:'b'}]}));
  assert.throws(()=>validateResponsesJson({...result(),output:[call,{...call,call_id:'different'}]}));
});
test('desktop restore preserves independent edits and removes only owned empty tables',()=>{
  const desired={model:'deepseek-flash-test','agents.default_subagent_model':'deepseek-flash-test'};
  const original={model:'synthetic-gpt',desktop:{localeOverride:'zh-CN'}};const snapshot=captureDesktopChange(original,desired);
  const current={...original,model:'deepseek-flash-test',agents:{default_subagent_model:'deepseek-flash-test',other:'new-user-edit'}};
  const edits=restoreDesktopEdits(current,snapshot);assert.ok(!edits.some(x=>x.keyPath==='agents'));
  assert.throws(()=>restoreDesktopEdits({...current,model:'user-new-model'},snapshot));
  const noOther={...current,agents:{default_subagent_model:'deepseek-flash-test'}};
  assert.ok(restoreDesktopEdits(noOther,snapshot).some(x=>x.keyPath==='agents'&&x.value===null));
});
test('loopback guard requires a local bearer and rejects browser origins and unexpected routes',async t=>{
  const policy={...settings};let calls=0;const logs=[];
  const server=createNativeServer({settings:policy,token:'SYNTHETIC-LOCAL-TOKEN',fingerprint:'synthetic-fingerprint',forward:async()=>{calls++;return{raw:encodeCompletedResponse(result()),stream:true};},diagnostic:async x=>logs.push(x)});
  await new Promise(yes=>server.listen(0,'127.0.0.1',yes));policy.port=server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(yes=>server.close(yes));});
  const base=`http://127.0.0.1:${policy.port}`;const headers={Authorization:'Bearer SYNTHETIC-LOCAL-TOKEN','Content-Type':'application/json'};
  assert.equal((await fetch(base+'/health')).status,403);
  assert.equal((await fetch(base+'/v1/responses',{method:'POST',headers:{...headers,Origin:'https://example.test'},body:JSON.stringify(body())})).status,403);
  assert.equal((await fetch(base+'/other',{headers})).status,404);
  const good=await fetch(base+'/v1/responses',{method:'POST',headers,body:JSON.stringify(body())});assert.equal(good.status,200);assert.equal(validateResponsesSse(await good.text()).response.status,'completed');assert.equal(calls,1);
  const health=await(await fetch(base+'/health',{headers})).json();assert.equal(health.fingerprint,'synthetic-fingerprint');
  assert.ok(!JSON.stringify(logs).includes('Synthetic user task'));assert.ok(!JSON.stringify(logs).includes('SYNTHETIC-LOCAL-TOKEN'));
});
test('idle guard replacement closes health connections and exposes the new fingerprint on the same port',async t=>{
  const policy={...settings};const headers={Authorization:'Bearer SYNTHETIC-LOCAL'};
  const first=createNativeServer({settings:policy,token:'SYNTHETIC-LOCAL',fingerprint:'old'});
  await new Promise(yes=>first.listen(0,'127.0.0.1',yes));policy.port=first.address().port;
  const base=`http://127.0.0.1:${policy.port}`;
  const health=await fetch(base+'/health',{headers});assert.equal(health.headers.get('connection'),'close');assert.equal((await health.json()).fingerprint,'old');
  const closed=new Promise(yes=>first.once('close',yes));
  const stopped=await fetch(base+'/shutdown',{method:'POST',headers});assert.equal(stopped.headers.get('connection'),'close');await stopped.text();await closed;
  const second=createNativeServer({settings:policy,token:'SYNTHETIC-LOCAL',fingerprint:'new'});
  await new Promise(yes=>second.listen(policy.port,'127.0.0.1',yes));
  t.after(async()=>{second.closeAllConnections();await new Promise(yes=>second.close(yes));});
  assert.equal((await(await fetch(base+'/health',{headers})).json()).fingerprint,'new');
});
