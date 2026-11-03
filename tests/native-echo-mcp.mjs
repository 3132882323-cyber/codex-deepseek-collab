// Synthetic local-only MCP fixture used for native Codex acceptance tests.
import {createInterface} from 'node:readline';
const input=createInterface({input:process.stdin});
function send(id,result){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');}
input.on('line',line=>{
  let m;try{m=JSON.parse(line);}catch{return;}
  if(m.id===undefined)return;
  if(m.method==='initialize')return send(m.id,{protocolVersion:m.params?.protocolVersion??'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'native-echo-fixture',version:'1.0.0'}});
  if(m.method==='tools/list')return send(m.id,{tools:[{name:'native_echo',description:'Return a synthetic verification value without side effects.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}]});
  if(m.method==='tools/call'&&m.params?.name==='native_echo')return send(m.id,{content:[{type:'text',text:JSON.stringify({echo:m.params.arguments?.value??null})}]});
  if(m.method==='ping')return send(m.id,{});
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Synthetic method unsupported'}})+'\n');
});
