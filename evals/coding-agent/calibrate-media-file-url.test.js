// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..'),app='apps/screenpipe-app-tauri';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-media-file-url-path');
const root=mkdtempSync(join(tmpdir(),'media-file-url-calibration-'));
const receipts=process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS;
const helper=`${app}/lib/utils/media-file-path.ts`,player=`${app}/components/rewind/media.tsx`;
const paths=[helper,player,`${app}/lib/actions/video-actions.ts`,`${app}/lib/utils.ts`,`${app}/lib/utils/tauri.ts`];
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function replace(cwd,file,from,to){const p=join(cwd,file),s=readFileSync(p,'utf8');expect(s.split(from)).toHaveLength(2);writeFileSync(p,s.replace(from,to));}
function grade(name,ref=item.oracle_ref,mutate=()=>{}){
 const cwd=join(root,name);mkdirSync(cwd);
 // Exact historical sources only. External dependencies are linked at grading.
 for(const path of paths){const dest=join(cwd,path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,execFileSync('git',['show',`${ref}:${path}`],{cwd:repo}));}
 for(const f of item.grader.fixtures){const dest=join(cwd,f.destination_path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(import.meta.dir,f.local_path)));}
 for(const link of item.grader_dependency_links)symlinkSync(join(repo,link.source_path),join(cwd,link.destination_path),'dir');
 mutate(cwd);
 const r=spawnSync('/bin/bash',['-c',item.grader.command],{cwd,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{PATH:process.env.PATH,HOME:cwd,CI:'true',TZ:'UTC',NO_COLOR:'1'}});
 if(receipts){mkdirSync(receipts,{recursive:true});writeFileSync(join(receipts,name+'.stdout'),r.stdout||'');writeFileSync(join(receipts,name+'.stderr'),r.stderr||'');writeFileSync(join(receipts,name+'.json'),JSON.stringify({ref,command:item.grader.command,exit_code:r.status,signal:r.signal,error:r.error?.message},null,2));}
 expect(r.error).toBeUndefined();expect(r.signal).toBeNull();return r;
}
function passes(r){expect(r.status).toBe(0);expect(r.stdout).toContain('9 passed');expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import/);}
function fails(r){expect(r.status).toBe(1);expect(r.stderr).toMatch(/AssertionError|Error: expect\(/);expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Cannot find module/);}
test('parent loses four reader paths and preserves five outcomes',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('4 failed | 5 passed');},60000);
test('historical fix passes all outcomes',()=>passes(grade('reference')),60000);
test('current caller passes all outcomes',()=>passes(grade('current','HEAD')),60000);
test('equivalent helper name passes',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{
 for(const path of [helper,player]){const p=join(cwd,path);writeFileSync(p,readFileSync(p,'utf8').replaceAll('normalizeMediaFilePath','preserveLocalPlayerPath'));}
})),60000);
test('unused correct helper cannot hide the broken active path',()=>fails(grade('unused',item.base_ref,cwd=>{
 writeFileSync(join(cwd,`${app}/unused-correct-media-path.ts`),execFileSync('git',['show',`${item.oracle_ref}:${helper}`],{cwd:repo}));
})),60000);
test('correct helper with a disconnected caller fails',()=>fails(grade('disconnected',item.oracle_ref,cwd=>{
 replace(cwd,player,'return normalizeMediaFilePath(path);','return path;');
})),60000);
test('blanket native-reading refusal fails preserved playback',()=>fails(grade('refusal',item.oracle_ref,cwd=>{
 replace(cwd,player,'const sanitizedPath = sanitizeFilePath(filePath);','return; const sanitizedPath = sanitizeFilePath(filePath);');
})),60000);
test('lost Windows drive fails preserved native identity',()=>fails(grade('windows',item.oracle_ref,cwd=>{
 replace(cwd,helper,'if (windowsMatch) return windowsMatch[0].trim();','if (windowsMatch) return "/" + windowsMatch[0].trim();');
})),60000);
test('audio-only presentation fails ordinary video',()=>fails(grade('audio-only',item.oracle_ref,cwd=>{
 replace(cwd,helper,'export function isAudioMediaPath(path: string): boolean {','export function isAudioMediaPath(path: string): boolean { return true;');
})),60000);
test('video-only presentation fails preserved audio',()=>fails(grade('video-only',item.oracle_ref,cwd=>{
 replace(cwd,helper,'export function isAudioMediaPath(path: string): boolean {','export function isAudioMediaPath(path: string): boolean { return false;');
})),60000);
test('empty input reading is rejected',()=>fails(grade('empty-read',item.oracle_ref,cwd=>{
 replace(cwd,player,'if (!sanitizedPath) {','if (!sanitizedPath) { await getMediaFile(sanitizedPath);');
})),60000);
test('missing player is setup failure, not baseline evidence',()=>{
 const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,player)));expect(r.status).toBe(1);expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/);expect(r.stderr).not.toMatch(/AssertionError/);
},60000);
