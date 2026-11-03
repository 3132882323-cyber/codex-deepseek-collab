// Codex Responses transport guard. Tool execution belongs to Codex, not this process.
import {createServer} from 'node:http';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig,loadCredential,getModelCapabilities,getOutputBudgetPolicy,safeTransportCode} from './deepseek-client.mjs';
import {prepareNativeRequest,validateResponsesJson,validateResponsesSse} from './deepseek-native-core.mjs';
import {adaptNativeTools} from './deepseek-native-tools.mjs';

const LIMIT=16*1024*1024;
const RETRYABLE=new Set([429,500,502,503,504]);
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
export class NativeGuardError extends Error {
  constructor(code,status=502){super('Native DeepSeek request stopped.');this.code=code;this.status=status;}
}
const sleep=(ms,signal)=>new Promise((yes,no)=>{
  if(signal?.aborted)return no(new NativeGuardError('cancelled',499));
  const stop=()=>{clearTimeout(timer);no(new NativeGuardError('cancelled',499));};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);yes();},ms);
  signal?.addEventListener('abort',stop,{once:true});
});
function stopBody(r){try{void r?.body?.cancel().catch(()=>{});}catch{}}
function safeCode(e){
  if(e?.name==='NativeProtocolError'&&typeof e.code==='string'&&/^[A-Z_]{1,32}$/.test(e.code))return 'native_protocol_'+e.code.toLowerCase();
  return typeof e?.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(e.code)?e.code:'native_request_failed';
}
export function validateSettings(s){
  if(!s||Object.getPrototypeOf(s)!==Object.prototype||s.version!==1
    ||typeof s.connection_state_dir!=='string'||!s.connection_state_dir
    ||typeof s.model!=='string'||!/^deepseek[\w.:-]+$/.test(s.model)||/pro/i.test(s.model)
    ||!Number.isSafeInteger(s.port)||s.port<1024||s.port>65535
    ||!Number.isSafeInteger(s.planned_output_tokens)||s.planned_output_tokens<16384||s.planned_output_tokens>393216){
    throw new NativeGuardError('native_settings_invalid',400);
  }
  if(s.context_window_tokens!==undefined&&(!Number.isSafeInteger(s.context_window_tokens)||s.context_window_tokens<32||s.context_window_tokens>1048576))throw new NativeGuardError('native_settings_invalid',400);
  return s;
}
export async function readSettings(state){
  const raw=await readFile(join(state,'settings.json'));
  if(raw.length>32768)throw new NativeGuardError('native_settings_invalid',400);
  return validateSettings(JSON.parse(raw.toString('utf8')));
}
export async function guardFingerprint(settings){
  const hash=createHash('sha256').update(JSON.stringify(settings));
  for(const name of ['deepseek-native.mjs','deepseek-native-core.mjs','deepseek-native-tools.mjs','deepseek-client.mjs','deepseek-budget.mjs','deepseek-stream.mjs'])hash.update(await readFile(new URL('./'+name,import.meta.url)));
  return hash.digest('hex');
}
// Only validated terminal items become executable events. Untrusted intermediate
// deltas/done events can never introduce a different or truncated tool call.
export function encodeCompletedResponse(response){
  validateResponsesJson(response);
  let sequence=0;const frames=[];
  const emit=(type,fields)=>frames.push(`event: ${type}\ndata: ${JSON.stringify({type,sequence_number:sequence++,...fields})}\n\n`);
  emit('response.created',{response:{...response,status:'in_progress',output:[]}});
  emit('response.in_progress',{response:{...response,status:'in_progress',output:[]}});
  response.output.forEach((item,index)=>{
    const empty={...item,status:'in_progress'};
    if(item.type==='message')empty.content=[];
    if(item.type==='function_call')empty.arguments='';
    if(item.type==='custom_tool_call')empty.input='';
    emit('response.output_item.added',{output_index:index,item:empty});
    if(item.type==='message')item.content.forEach((part,contentIndex)=>{
      if(part.type!=='output_text')return;
      emit('response.content_part.added',{item_id:item.id,output_index:index,content_index:contentIndex,part:{...part,text:''}});
      emit('response.output_text.delta',{item_id:item.id,output_index:index,content_index:contentIndex,delta:part.text});
      emit('response.output_text.done',{item_id:item.id,output_index:index,content_index:contentIndex,text:part.text});
      emit('response.content_part.done',{item_id:item.id,output_index:index,content_index:contentIndex,part});
    });
    if(item.type==='function_call'){
      emit('response.function_call_arguments.delta',{item_id:item.id,output_index:index,delta:item.arguments});
      emit('response.function_call_arguments.done',{item_id:item.id,output_index:index,arguments:item.arguments});
    }
    if(item.type==='custom_tool_call'){
      emit('response.custom_tool_call_input.delta',{item_id:item.id,output_index:index,delta:item.input});
      emit('response.custom_tool_call_input.done',{item_id:item.id,output_index:index,input:item.input});
    }
    emit('response.output_item.done',{output_index:index,item});
  });
  emit('response.completed',{response});
  return frames.join('');
}
export async function readBoundedResponse(response,signal){
  const declared=response.headers.get('content-length');
  if(declared&&/^\d+$/.test(declared)&&Number(declared)>LIMIT){stopBody(response);throw new NativeGuardError('native_response_too_large');}
  if(!response.body)throw new NativeGuardError('native_response_invalid');
  const reader=response.body.getReader();const chunks=[];let bytes=0;
  try{
    for(;;){
      if(signal?.aborted)throw new NativeGuardError('native_request_timeout');
      const part=await reader.read();if(part.done)break;
      bytes+=part.value.byteLength;
      if(bytes>LIMIT){void reader.cancel().catch(()=>{});throw new NativeGuardError('native_response_too_large');}
      chunks.push(part.value);
    }
    return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
  }finally{reader.releaseLock();}
}
function retryDelay(value,attempt){
  const base=Math.min(10000,1000*2**(attempt-1));
  if(value===null)return base;
  const seconds=/^\d+(\.\d+)?$/.test(value.trim())?Number(value)*1000:Date.parse(value)-Date.now();
  if(!Number.isFinite(seconds))return base;
  const ms=Math.max(base,Math.ceil(seconds));
  if(ms>10000)throw new NativeGuardError('native_retry_cooldown',429);
  return ms;
}
// Injected dependencies are only for offline contract tests. Production always uses fetch/DPAPI.
export async function forwardNative(input,settings,{signal,fetchImpl=fetch,credentialLoader=loadCredential,configLoader=loadConfig,onAttempt=()=>{}}={}){
  validateSettings(settings);
  const config=await configLoader(settings.connection_state_dir);
  if(config.models.flash!==settings.model||own(config.models,'pro'))throw new NativeGuardError('native_flash_only',400);
  const capabilities=getModelCapabilities(config,'flash');
  const min=getOutputBudgetPolicy(config,'flash')?.max_reasoning_min_output_tokens??16384;
  if(settings.planned_output_tokens<min||settings.planned_output_tokens>capabilities.max_output_tokens)throw new NativeGuardError('native_budget_invalid',400);
  // This policy check precedes upstream credential access and all upstream HTTP.
  const planned=prepareNativeRequest(input,{model:settings.model,plannedOutputTokens:settings.planned_output_tokens,minOutputTokens:min,maxOutputTokens:capabilities.max_output_tokens});
  const {request:body,restoreResponse}=adaptNativeTools(planned);
  const target=new URL(config.base_url+'/responses');
  if(target.protocol!=='https:'||target.origin!==config.allowed_origin||target.username||target.password||target.search||target.hash)throw new NativeGuardError('native_destination_refused',400);
  if(signal?.aborted)throw new NativeGuardError('cancelled',499);
  const credential=await credentialLoader(config,settings.connection_state_dir);
  const started=performance.now();let attempts=0;
  for(let attempt=1;attempt<=3;attempt++){
    if(signal?.aborted)throw new NativeGuardError('cancelled',499);
    const remaining=360000-(performance.now()-started);
    if(remaining<=0)throw new NativeGuardError('native_budget_timeout');
    const controller=new AbortController();
    const cancelled=()=>controller.abort();signal?.addEventListener('abort',cancelled,{once:true});
    const timer=setTimeout(()=>controller.abort(),Math.min(180000,remaining));let response;
    try{
      attempts=attempt;onAttempt({attempt});
      response=await fetchImpl(target,{method:'POST',redirect:'manual',signal:controller.signal,
        headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json',Accept:body.stream?'text/event-stream':'application/json'},body:JSON.stringify(body)});
      onAttempt({attempt,http_status:response.status});
      if(!response.ok){
        stopBody(response);
        if(RETRYABLE.has(response.status)&&attempt<3){
          const delay=retryDelay(response.headers.get('retry-after'),attempt);
          if(360000-(performance.now()-started)<=delay+1000)throw new NativeGuardError('native_budget_timeout');
          clearTimeout(timer);signal?.removeEventListener('abort',cancelled);
          await sleep(delay,signal);continue;
        }
        // Avoid a second authentication-layer replay by Codex on an upstream 401.
        throw new NativeGuardError(response.status===401||response.status===403?'native_upstream_auth':'native_upstream_http',response.status===401||response.status===403?400:response.status>=400&&response.status<600?response.status:502);
      }
      const raw=await readBoundedResponse(response,controller.signal);
      if(controller.signal.aborted||signal?.aborted)throw new NativeGuardError(signal?.aborted?'cancelled':'native_request_timeout');
      let output=raw;
      if(body.stream){
        if(!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream'))throw new NativeGuardError('native_content_type');
        output=encodeCompletedResponse(restoreResponse(validateResponsesSse(raw).response));
      }else{
        output=JSON.stringify(validateResponsesJson(restoreResponse(validateResponsesJson(JSON.parse(raw)))));
      }
      return {raw:output,stream:body.stream===true,attempts,status:response.status};
    }catch(e){
      // Only the explicit non-2xx status branch above can retry.
      if(signal?.aborted)throw new NativeGuardError('cancelled',499);
      if(controller.signal.aborted)throw new NativeGuardError('native_request_timeout');
      if(e instanceof NativeGuardError)throw e;
      const failure=new NativeGuardError(safeCode(e));failure.cause=e;throw failure;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancelled);}
  }
  throw new NativeGuardError('native_request_failed');
}
function authenticated(header,token){
  if(typeof header!=='string'||header.length>8192)return false;
  const a=createHash('sha256').update(header).digest();const b=createHash('sha256').update('Bearer '+token).digest();
  return timingSafeEqual(a,b);
}
function errorResponse(res,status,code){
  if(res.destroyed)return;
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
  res.end(JSON.stringify({error:{type:'native_guard_error',code,message:'DeepSeek native request stopped; see the local diagnostic code. No ambiguous failure was replayed.'}}));
}
async function requestJson(req){
  const chunks=[];let bytes=0;
  for await(const chunk of req){bytes+=chunk.length;if(bytes>LIMIT)throw new NativeGuardError('native_input_too_large',413);chunks.push(chunk);}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
  catch{throw new NativeGuardError('native_input_invalid',400);}
}
export function createNativeServer({settings,token,fingerprint='test-only',stateDir,forward=forwardNative,diagnostic=async()=>{}}){
  validateSettings(settings);let active=0;
  const server=createServer(async(req,res)=>{
    const started=performance.now();let attempts=0,httpStatus=null;
    if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==`127.0.0.1:${settings.port}`||req.headers.origin!==undefined||req.headers['sec-fetch-site']!==undefined||!authenticated(req.headers.authorization,token)){
      errorResponse(res,403,'native_local_auth');return;
    }
    if(req.method==='GET'&&req.url==='/health'){
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store',Connection:'close'});res.end(JSON.stringify({service:'codex-deepseek-native',version:1,fingerprint}));return;
    }
    if(req.method==='POST'&&req.url==='/shutdown'){
      if(active!==0){errorResponse(res,409,'native_busy');return;}
      res.writeHead(200,{'Content-Type':'application/json',Connection:'close'});res.end('{"ok":true}');server.close();server.closeIdleConnections();return;
    }
    if(req.method!=='POST'||req.url!=='/v1/responses'){errorResponse(res,404,'native_route_refused');return;}
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??'')){errorResponse(res,415,'native_content_type');return;}
    if(active>=4){errorResponse(res,429,'native_busy');return;}
    active++;
    const controller=new AbortController();
    const cancel=()=>{if(!res.writableFinished)controller.abort();};res.once('close',cancel);req.once('aborted',cancel);
    const totalTimer=setTimeout(()=>controller.abort(),360000);
    let code=null,transportCode=null;
    try{
      const input=await requestJson(req);
      const result=await forward(input,settings,{signal:controller.signal,onAttempt:m=>{attempts=m.attempt;httpStatus=m.http_status??null;}});
      if(controller.signal.aborted||res.destroyed)throw new NativeGuardError('cancelled',499);
      res.writeHead(200,{'Content-Type':result.stream?'text/event-stream; charset=utf-8':'application/json; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
      res.end(result.raw);
    }catch(e){code=safeCode(e);transportCode=safeTransportCode(e);errorResponse(res,e instanceof NativeGuardError?e.status:400,code);}
    finally{
      clearTimeout(totalTimer);active--;res.removeListener('close',cancel);req.removeListener('aborted',cancel);
      await diagnostic({event:'native_response',ok:code===null,code,transport_code:transportCode,attempts,http_status:httpStatus,model:'flash',reasoning_effort:'max',planned_output_tokens:settings.planned_output_tokens,elapsed_ms:Math.round(performance.now()-started)}).catch(()=>{});
    }
  });
  server.requestTimeout=30000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
  return server;
}
async function ensureToken(state){
  const dir=join(state,'relay-auth');await mkdir(dir,{recursive:true});
  try{return await loadCredential({credential_source:'dpapi'},dir);}catch(e){
    if(e.code!=='credential_unavailable')throw e;
  }
  const token=randomBytes(32).toString('base64url');
  const command="$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd()) -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString -SecureString $s)); $s.Dispose()";
  const encrypted=execFileSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{input:token,encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe'],timeout:15000,maxBuffer:65536});
  try{await writeFile(join(dir,'credential.dpapi'),encrypted.trim()+'\n',{flag:'wx',mode:0o600});return token;}
  catch(e){if(e.code!=='EEXIST')throw e;return loadCredential({credential_source:'dpapi'},dir);}
}
async function health(settings,token){
  try{
    const r=await fetch(`http://127.0.0.1:${settings.port}/health`,{headers:{Authorization:'Bearer '+token,Connection:'close'},redirect:'error',signal:AbortSignal.timeout(700)});
    if(!r.ok){stopBody(r);return null;}
    const b=await r.json();return b.service==='codex-deepseek-native'&&b.version===1?b:null;
  }catch{return null;}
}
export async function ensureNativeGuard(state){
  const settings=await readSettings(state);const token=await ensureToken(state);const fingerprint=await guardFingerprint(settings);
  const current=await health(settings,token);
  if(current&&current.fingerprint!==fingerprint){
    const response=await fetch(`http://127.0.0.1:${settings.port}/shutdown`,{method:'POST',headers:{Authorization:'Bearer '+token,Connection:'close'},redirect:'error',signal:AbortSignal.timeout(1000)});
    stopBody(response);if(!response.ok)throw new NativeGuardError('native_guard_update_busy');
    await sleep(150);
  }
  if(!current||current.fingerprint!==fingerprint){
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'serve','--state-dir',state],{detached:true,windowsHide:true,stdio:'ignore'});
    child.on('error',()=>{});child.unref();
    const readyDeadline=performance.now()+15000;
    while(performance.now()<readyDeadline){if((await health(settings,token))?.fingerprint===fingerprint)return{settings,token};await sleep(100);}
    throw new NativeGuardError('native_guard_unavailable');
  }
  return{settings,token};
}
async function main(){
  const [action,...args]=process.argv.slice(2);
  if(args.length!==0&&(args.length!==2||args[0]!=='--state-dir'))throw new NativeGuardError('native_argument_invalid',400);
  const state=resolve(args[1]??join(homedir(),'.codex/deepseek-native'));
  if(action==='auth'){
    const {token}=await ensureNativeGuard(state);
    // Credential-command protocol: stdout is consumed privately by Codex only.
    process.stdout.write(token);return;
  }
  if(action==='status'){
    const settings=await readSettings(state);const token=await ensureToken(state);
    const current=await health(settings,token);
    console.log(JSON.stringify({configured:true,running:current!==null,current:current?.fingerprint===await guardFingerprint(settings),model:'flash',reasoning_effort:'max',planned_output_tokens:settings.planned_output_tokens}));return;
  }
  if(action==='serve'){
    const settings=await readSettings(state);const token=await ensureToken(state);
    const diagnostic=entry=>appendFile(join(state,'diagnostics.jsonl'),JSON.stringify({timestamp:new Date().toISOString(),...entry})+'\n');
    const fingerprint=await guardFingerprint(settings);
    const server=createNativeServer({settings,token,fingerprint,stateDir:state,diagnostic});
    server.on('error',()=>{process.exitCode=1;});
    server.listen(settings.port,'127.0.0.1');return;
  }
  throw new NativeGuardError('native_argument_invalid',400);
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){
  main().catch(e=>{process.stderr.write(JSON.stringify({ok:false,error_code:safeCode(e)})+'\n');process.exitCode=1;});
}
