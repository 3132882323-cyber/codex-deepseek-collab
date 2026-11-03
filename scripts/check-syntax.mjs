import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('package.json',root),'utf8'));
let failed=false,count=0;
for(const path of manifest.files.filter(x=>/\.(?:mjs|cjs)$/.test(x))){
  if(path.startsWith('/')||path.split(/[\\/]/).includes('..'))throw new Error('Invalid manifest path.');
  const result=spawnSync(process.execPath,['--check',fileURLToPath(new URL(path,root))],{stdio:'ignore',windowsHide:true,timeout:10000});
  count++;if(result.status!==0){console.error('Syntax check failed: '+path);failed=true;}
}
console.log(JSON.stringify({ok:!failed,syntax_files:count}));if(failed)process.exitCode=1;
