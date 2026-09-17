import fs from 'node:fs/promises';
import { fork } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
const self = fileURLToPath(import.meta.url);
const method = process.argv[3];
let api;
async function replace(source, target, method) {
  if (method === 'node') return fs.rename(source, target);
  if (!api) {
    const koffi = (await import('koffi')).default;
    const dll = koffi.load('kernel32.dll');
    api = {
      move: dll.func('int __stdcall MoveFileExW(str16, str16, uint32)'),
      replace: dll.func('int __stdcall ReplaceFileW(str16, str16, str16, uint32, void *, void *)'),
      error: dll.func('uint32 __stdcall GetLastError()'),
    };
  }
  const ok = method === 'move' ? api.move(source, target, 1) : api.replace(target, source, null, 0, null, null);
  if (!ok) throw Object.assign(new Error(`${method} failed`), {code: api.error(), syscall: method});
}
function describe(error) { return {code: error.code, syscall:error.syscall, message:error.message}; }
async function attempt(root, method, label) {
  const source = join(root, `${label}.tmp`), target = join(root,'credential.json');
  await fs.writeFile(source, JSON.stringify({secret:label}));
  try { await replace(source,target,method); return {ok:true}; }
  catch (error) {return {ok:false,error:describe(error)};}
  finally {await fs.rm(source,{force:true});}
}
if (process.argv[2] === 'child') {
  const root = process.argv[4], role=process.argv[5];
  if (role === 'reader') {
    const file = await fs.open(join(root,'credential.json'),'r');
    process.send({ready:true});
    await once(process,'message');
    await file.close();
  } else {
    process.send({ready:true});
    await once(process,'message');
    let successes=0; const errors=[];
    for(let i=0;i<150;i++) {
      const result=await attempt(root,method,`${process.pid}-${i}`);
      if(result.ok) successes++; else errors.push(result.error);
    }
    process.send({successes,errors});
  }
  process.disconnect();
} else {
  const root = await fs.mkdtemp(join(tmpdir(),'hypit-replace-diagnosis-'));
  const results = {platform:process.platform,node:process.version,uv:process.versions.uv,cases:[]};
  async function area(name) {
    const path=join(root,name);await fs.mkdir(path);await fs.writeFile(join(path,'credential.json'),JSON.stringify({secret:'old'}));return path;
  }
  function worker(root,method,role) {
    const process=fork(self,['child',method,root,role],{stdio:['ignore','inherit','inherit','ipc'],windowsHide:true});
    const exit=once(process,'exit');
    const ready=once(process,'message');
    return {process,ready,exit};
  }
  try {
    for(const method of ['node','move','replace']) {
      let path=await area(`${method}-sequential`);
      results.cases.push({method,scenario:'sequential',result:await attempt(path,method,'new')});
      path=await area(`${method}-same-process-reader`);
      const file=await fs.open(join(path,'credential.json'),'r');
      const result=await attempt(path,method,'new');
      await file.close();
      results.cases.push({method,scenario:'same-process-open-reader',result});
      path=await area(`${method}-other-process-reader`);
      const reader=worker(path,method,'reader');await reader.ready;
      const result2=await attempt(path,method,'new');reader.process.send('close');await reader.exit;
      results.cases.push({method,scenario:'other-process-open-reader',result:result2});
      path=await area(`${method}-two-writers`);
      const writers=[worker(path,method,'writer'),worker(path,method,'writer')];
      await Promise.all(writers.map(w=>w.ready));
      const reports=writers.map(w=>once(w.process,'message'));
      writers.forEach(w=>w.process.send('go'));
      const raw=(await Promise.all(reports)).map(([report])=>report);
      await Promise.all(writers.map(w=>w.exit));
      const counts={};let successes=0;
      for(const report of raw) {successes+=report.successes;for(const err of report.errors){const key=`${err.syscall}:${err.code}`;counts[key]=(counts[key]??0)+1;}}
      const stored=JSON.parse(await fs.readFile(join(path,'credential.json'),'utf8'));
      results.cases.push({method,scenario:'two-process-writers',successes,failures:counts,samples:raw.flatMap(x=>x.errors).slice(0,3),completeValue:typeof stored.secret==='string'});
    }
    console.log(JSON.stringify(results,null,2));
    await fs.writeFile('windows-replace-results.json',JSON.stringify(results,null,2));
  } finally {await fs.rm(root,{recursive:true,force:true});}
}
