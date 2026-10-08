// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..'),app='apps/screenpipe-app-tauri';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-codex-embedded-image-import');
const root=mkdtempSync(join(tmpdir(),'codex-images-calibration-'));
const receipts=process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS;
const parser=`${app}/lib/chat/external-chat-parser.ts`,importer=`${app}/lib/chat/external-chat-import.ts`;
const paths=[parser,importer,`${app}/lib/chat-storage.ts`];
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
function passes(r){expect(r.status).toBe(0);expect(r.stdout).toContain('11 passed');expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import/);}
function fails(r){expect(r.status).toBe(1);expect(r.stderr).toMatch(/AssertionError|Error: expect\(/);expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Cannot find module/);}
test('parent fails five attachment outcomes and preserves six',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('5 failed | 6 passed');},60000);
test('historical reference passes eleven',()=>passes(grade('reference')),60000);
test('current source passes eleven',()=>passes(grade('current','HEAD')),60000);
test('equivalent private helper name passes',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{const p=join(cwd,parser);writeFileSync(p,readFileSync(p,'utf8').replaceAll('codexImages','readEmbeddedImages'));})),60000);
test('unused fixed parser cannot hide the broken importer',()=>fails(grade('bypass',item.base_ref,cwd=>{writeFileSync(join(cwd,`${app}/unused-parser.ts`),execFileSync('git',['show',`${item.oracle_ref}:${parser}`],{cwd:repo}));})),60000);
test('fixed parser with old sync comparison fails refresh',()=>fails(grade('old-comparison',item.oracle_ref,cwd=>{writeFileSync(join(cwd,importer),execFileSync('git',['show',`${item.base_ref}:${importer}`],{cwd:repo}));})),60000);
test('dropping image-only messages is rejected',()=>fails(grade('image-only',item.oracle_ref,cwd=>{replace(cwd,parser,'if (!userText && images.length === 0) continue;','if (!userText) continue;');})),60000);
test('unsafe image admission is rejected',()=>fails(grade('unsafe',item.oracle_ref,cwd=>{replace(cwd,parser,'? url : undefined;','? url : url;');})),60000);
test('retaining transport envelopes is rejected',()=>fails(grade('transport',item.oracle_ref,cwd=>{replace(cwd,parser,'const userText = codexImageText(cleanCodexUserText(text), imageParts);','const userText = cleanCodexUserText(text);');})),60000);
test('losing user conversation state is rejected',()=>fails(grade('preserved',item.oracle_ref,cwd=>{replace(cwd,importer,'...existing,','');})),60000);
test('missing parser remains infrastructure failure',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,parser)));expect(r.status).toBe(1);expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url|Cannot find module/);expect(r.stderr).not.toMatch(/AssertionError/);},60000);
