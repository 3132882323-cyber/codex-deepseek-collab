// Uses the public app-server configuration API; never creates a chat or reads auth files.
import {spawn} from 'node:child_process';
import {readFile,writeFile,unlink,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {ensureNativeGuard,readSettings} from './deepseek-native.mjs';

export async function openConfigClient(codex,codexHome){
  const child=spawn(codex,['--no-daemon','app-server','--stdio'],{env:{...process.env,CODEX_HOME:codexHome},stdio:['pipe','pipe','ignore'],windowsHide:true});
  let next=0,buffer='';const pending=new Map();
  const fail=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('native_config_server_stopped'));}pending.clear();};
  child.on('error',fail);child.on('exit',fail);
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
    buffer+=chunk;if(Buffer.byteLength(buffer)>2*1024*1024){child.kill();fail();return;}
    for(;;){const at=buffer.indexOf('\n');if(at<0)break;const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line.trim())continue;
      try{const message=JSON.parse(line);const p=pending.get(message.id);if(!p)continue;clearTimeout(p.timer);pending.delete(message.id);if(message.error)p.reject(new Error('native_config_rpc_failed'));else p.resolve(message.result);}catch{}
    }
  });
  const call=(method,params)=>new Promise((yes,no)=>{
    const id=++next;const timer=setTimeout(()=>{pending.delete(id);no(new Error('native_config_timeout'));},15000);
    pending.set(id,{resolve:yes,reject:no,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  try{await call('initialize',{clientInfo:{name:'deepseek-native-config',version:'0.6.0'},capabilities:{experimentalApi:true}});child.stdin.write('{"method":"initialized"}\n');}
  catch(e){child.kill();throw e;}
  return{call,close:()=>{child.stdin.end();child.kill();fail();}};
}
export function desiredDesktopConfig(settings,{state,codexHome,nodePath,guardPath}){
  const model=settings.model;
  const context=settings.context_window_tokens??524288;
  return {
    model,model_provider:'deepseek-native',model_reasoning_effort:'max',model_reasoning_summary:'none',
    model_catalog_json:join(state,'models.json'),model_context_window:context,
    model_auto_compact_token_limit:Math.floor(context*.7),web_search:'disabled',
    'features.unbounded_connection_retries':false,'features.enable_request_compression':false,
    'model_providers.deepseek-native':{name:'DeepSeek Flash (native)',base_url:`http://127.0.0.1:${settings.port}/v1`,wire_api:'responses',request_max_retries:0,stream_max_retries:0,stream_idle_timeout_ms:370000,supports_websockets:false,capabilities:{remote_compaction:'unsupported',external_web_access:false},auth:{command:nodePath,args:[guardPath,'auth','--state-dir',state],timeout_ms:20000,refresh_interval_ms:0}},
    'agents.default_subagent_model':model,'agents.default_subagent_reasoning_effort':'max',
    'desktop.enabled-reasoning-efforts':['max']
  };
}
function getAt(o,path){for(const key of path.split('.')){if(o===null||typeof o!=='object'||!Object.hasOwn(o,key))return{present:false};o=o[key];}return{present:true,value:o};}
export function captureDesktopChange(userConfig,desired){
  if(getAt(userConfig,'model_provider').value==='deepseek-native')throw new Error('already_native');
  if(getAt(userConfig,'model_providers.deepseek-native').present)throw new Error('native_provider_conflict');
  const parents=[...new Set(Object.keys(desired).filter(k=>k.includes('.')).map(k=>k.split('.')[0]))];
  return{version:1,before:Object.fromEntries(Object.keys(desired).map(k=>[k,getAt(userConfig,k)])),after:desired,createdParents:parents.filter(k=>!Object.hasOwn(userConfig,k))};
}
export function restoreDesktopEdits(userConfig,snapshot){
  if(snapshot?.version!==1||!snapshot.before||!snapshot.after)throw new Error('native_snapshot_invalid');
  for(const [key,value] of Object.entries(snapshot.after))if(!isDeepStrictEqual(getAt(userConfig,key).value,value))throw new Error('native_config_changed');
  const edits=Object.entries(snapshot.before).map(([key,previous])=>({keyPath:key,mergeStrategy:'replace',value:previous.present?previous.value:null}));
  const restored=structuredClone(userConfig);
  for(const [key,previous] of Object.entries(snapshot.before)){
    const bits=key.split('.');const leaf=bits.pop();let parent=restored;for(const bit of bits)parent=parent[bit];
    if(previous.present)parent[leaf]=previous.value;else delete parent[leaf];
  }
  for(const key of snapshot.createdParents??[])if(restored[key]&&Object.keys(restored[key]).length===0)edits.push({keyPath:key,value:null,mergeStrategy:'replace'});
  return edits;
}
async function userLayer(result,file){
  const actual=await realpath(file);
  const layer=result.layers?.find(x=>x.name?.type==='user'&&resolve(x.name.file).toLowerCase()===actual.toLowerCase());
  if(!layer||!layer.config||typeof layer.config!=='object')throw new Error('native_user_layer_missing');
  return layer;
}
export async function switchDesktop(action,state,{startGuard=true}={}){
  const launch=JSON.parse(await readFile(join(state,'launch.json'),'utf8'));
  const file=join(launch.codex_home,'config.toml');const backup=join(state,'desktop-switch.json');
  const client=await openConfigClient(launch.codex_bin,launch.codex_home);
  try{
    const result=await client.call('config/read',{includeLayers:true});const layer=await userLayer(result,file);
    let edits;
    if(action==='enable'){
      const settings=await readSettings(state);
      if(startGuard)await ensureNativeGuard(state);
      const desired=desiredDesktopConfig(settings,{state,codexHome:launch.codex_home,nodePath:process.execPath,guardPath:fileURLToPath(new URL('./deepseek-native.mjs',import.meta.url))});
      const snapshot=captureDesktopChange(layer.config,desired);
      await writeFile(backup,JSON.stringify(snapshot,null,2)+'\n',{flag:'wx',mode:0o600});
      edits=Object.entries(desired).map(([key,value])=>({keyPath:key,value,mergeStrategy:'replace'}));
    }else if(action==='restore'){
      const snapshot=JSON.parse(await readFile(backup,'utf8'));edits=restoreDesktopEdits(layer.config,snapshot);
    }else throw new Error('native_action_invalid');
    await client.call('config/batchWrite',{filePath:file,expectedVersion:layer.version,edits,reloadUserConfig:false});
    if(action==='restore')await unlink(backup);
    return{ok:true,mode:action==='enable'?'deepseek-flash':'previous',restart_required:true};
  }finally{client.close();}
}
async function main(){
  const [action,...args]=process.argv.slice(2);
  if(args.length!==0&&(args.length!==2||args[0]!=='--state-dir'))throw new Error();
  const state=resolve(args[1]??join(homedir(),'.codex/deepseek-native'));
  await switchDesktop(action,state);
  console.log(action==='enable'?'已切换到 DeepSeek Flash。请关闭并重新打开 Codex 后使用。':'已恢复原来的 GPT 配置。请关闭并重新打开 Codex 后使用。');
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){main().catch(()=>{process.stderr.write('切换已停止：配置可能已被更改，或本机服务未就绪。请让 Codex 检查，避免覆盖你的配置。\n');process.exitCode=1;});}
