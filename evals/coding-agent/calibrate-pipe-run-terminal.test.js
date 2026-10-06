// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo=resolve(import.meta.dir,'../..');
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(x=>x.id==='app-pipe-run-terminal-preservation');
const base='apps/screenpipe-app-tauri/';const path=base+'lib/events/pipe-run-recorder.ts';
const show=(ref,p)=>execFileSync('git',['show',`${ref}:${p}`],{cwd:repo,encoding:'utf8'});
const broken=show(item.base_ref,path),fixed=show(item.oracle_ref,path);
const root=mkdtempSync(join(tmpdir(),'pipe-terminal-calibration-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,source,ref=item.base_ref,unused=false){
 const cwd=join(root,name);const write=(p,t)=>{mkdirSync(dirname(join(cwd,p)),{recursive:true});writeFileSync(join(cwd,p),t);};
 if(source!==null)write(path,source);
 for(const p of ['lib/events/types.ts','lib/pipe-ndjson-to-chat.ts',...(ref==='HEAD'?['lib/pipe-conversation.ts','lib/pipe-execution-status.ts']:[])])write(base+p,show(ref,base+p));
 if(unused)write(base+'lib/events/unused-repair.ts',fixed);
 write(base+'tsconfig.json',JSON.stringify({compilerOptions:{baseUrl:'.',paths:{'@/*':['./*']}}}));
 const f=item.grader.fixtures[0];write(f.destination_path,readFileSync(join(import.meta.dir,f.local_path),'utf8'));
 const r=spawnSync(process.execPath,['--no-env-file','test',f.destination_path],{cwd,encoding:'utf8',timeout:30000,env:{PATH:dirname(process.execPath)}});
 if(process.env.PIPE_TERMINAL_RESULTS){const out=resolve(process.env.PIPE_TERMINAL_RESULTS);mkdirSync(out,{recursive:true});for(const ext of ['stdout','stderr'])writeFileSync(join(out,name+'.'+ext),r[ext]??'');writeFileSync(join(out,name+'.json'),JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message??null}));}
 return r;
}
function pass(r){expect(r.error).toBeUndefined();expect(r.status).toBe(0);expect(r.stderr).toContain('8 pass');}
function fail(r){expect(r.error).toBeUndefined();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(r.stderr).not.toContain('Cannot find module');}
function patch(a,b){expect(fixed.split(a)).toHaveLength(2);return fixed.replace(a,b);}
test('parent fails two behaviors and preserves six',()=>{const r=grade('parent',broken);fail(r);expect(r.stderr).toContain('2 fail');expect(r.stderr).toContain('6 pass');});
test('historical recorder fix passes with base parser',()=>pass(grade('reference',fixed)));
test('current source passes',()=>pass(grade('current',show('HEAD',path),'HEAD')));
test('equivalent guard passes',()=>pass(grade('equivalent',patch('typeof inner.type === "string" && TERMINAL_EVENT_TYPES.has(inner.type)','inner.type === "agent_end" || inner.type === "pipe_done"'))));
test('unused correct recorder cannot bypass mounted behavior',()=>fail(grade('unused',broken,item.base_ref,true)));
test('intermediate save mutation is rejected',()=>fail(grade('intermediate',patch('"agent_end",\n  "pipe_done",','"agent_end",\n  "turn_end",\n  "pipe_done",'))));
test('blanket no-save workaround rejected',()=>fail(grade('nosave',patch('async function finalizeBuffer(sid: string, buf: PipeRunBuffer): Promise<void> {','async function finalizeBuffer(sid: string, buf: PipeRunBuffer): Promise<void> { return;'))));
test('history preference bypass rejected',()=>fail(grade('history',patch('if (settings?.chatHistory?.historyEnabled === false) return;','if (false) return;'))));
test('foreign source bypass rejected',()=>fail(grade('foreign',patch('if (envelope.source !== "pipe") return;','if (false) return;'))));
test('missing recorder remains setup error',()=>{const r=grade('missing',null);expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).not.toContain('expect(received)');});
