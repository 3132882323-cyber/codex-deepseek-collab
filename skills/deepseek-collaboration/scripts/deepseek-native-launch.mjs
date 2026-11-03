// Starts Codex's own interactive/tool loop with the Flash profile.
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {ensureNativeGuard} from './deepseek-native.mjs';
async function main(){
  const args=process.argv.slice(2);let state=join(homedir(),'.codex/deepseek-native');
  if(args[0]==='--native-state'){if(!args[1])throw new Error();state=resolve(args[1]);args.splice(0,2);}
  const launch=JSON.parse(await readFile(join(state,'launch.json'),'utf8'));
  if(typeof launch.codex_bin!=='string'||typeof launch.codex_home!=='string')throw new Error();
  await ensureNativeGuard(state);
  const child=spawn(launch.codex_bin,['--no-daemon','--profile','deepseek-flash',...args],{stdio:'inherit',windowsHide:false,env:{...process.env,CODEX_HOME:launch.codex_home}});
  child.on('error',()=>{process.stderr.write('Codex could not be started.\n');process.exitCode=1;});
  child.on('exit',code=>{process.exitCode=code??1;});
}
main().catch(()=>{process.stderr.write('DeepSeek native profile could not be started.\n');process.exitCode=1;});
