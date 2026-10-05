// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..'),app='apps/screenpipe-app-tauri';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(x=>x.id==='app-unmarked-html-file-preview');
const root=mkdtempSync(join(tmpdir(),'html-viewer-calibration-')),archives=new Map();
const receipts=process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS;
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function replace(cwd,file,from,to){const p=join(cwd,app,file),s=readFileSync(p,'utf8');expect(s.split(from)).toHaveLength(2);writeFileSync(p,s.replace(from,to));}
function grade(name,ref=item.oracle_ref,mutate=()=>{}){
 const cwd=join(root,name);mkdirSync(cwd);
 if(!archives.has(ref)){
  const paths=execFileSync('git',['ls-tree','--name-only',`${ref}:${app}`],{cwd:repo,encoding:'utf8'}).trim().split('\n').filter(x=>!['src-tauri','public','e2e','.e2e'].includes(x)&&!x.startsWith('.env')).map(x=>`${app}/${x}`);
  archives.set(ref,execFileSync('git',['archive',ref,...paths],{cwd:repo,maxBuffer:128*1024*1024}));
 }
 execFileSync('tar',['-x','-C',cwd],{input:archives.get(ref)});
 for(const f of item.grader.fixtures){const dest=join(cwd,f.destination_path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(import.meta.dir,f.local_path)));}
 for(const link of item.grader_dependency_links){const dest=join(cwd,link.destination_path);mkdirSync(dirname(dest),{recursive:true});symlinkSync(join(repo,link.source_path),dest,'dir');}
 mutate(cwd);
 const r=spawnSync('/bin/bash',['-c',item.grader.command],{cwd,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{PATH:process.env.PATH,HOME:cwd,CI:'true',TZ:'UTC',NO_COLOR:'1'}});
 if(receipts){mkdirSync(receipts,{recursive:true});writeFileSync(join(receipts,name+'.stdout'),r.stdout||'');writeFileSync(join(receipts,name+'.stderr'),r.stderr||'');writeFileSync(join(receipts,name+'.json'),JSON.stringify({ref,command:item.grader.command,exit:r.status,signal:r.signal,error:r.error?.message},null,2));}
 expect(r.error).toBeUndefined();expect(r.signal).toBeNull();return r;
}
function passes(r){expect(r.status).toBe(0);expect(r.stderr).toContain('12 pass');expect(r.stderr).toContain('0 fail');}
function fails(r){expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received).toBe(expected)');expect(r.stdout+r.stderr).not.toMatch(/Unhandled error|ModuleNotFound|Cannot find module/);}
const viewer='components/file-viewer.tsx',frame='components/file-viewer-html-frame.tsx';
test('parent has five intended failures and seven preserved passes',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stderr).toContain('5 fail');expect(r.stderr).toContain('7 pass');},60000);
test('historical reference passes',()=>passes(grade('reference')),60000);
test('current source passes',()=>passes(grade('current','HEAD')),60000);
test('unused correct component does not hide broken caller',()=>fails(grade('unused',item.oracle_ref,cwd=>{writeFileSync(join(cwd,app,'unused-correct-viewer.tsx'),readFileSync(join(cwd,app,viewer)));writeFileSync(join(cwd,app,viewer),execFileSync('git',['show',`${item.base_ref}:${app}/${viewer}`],{cwd:repo}));})),60000);
test('empty iframe loses meaningful content',()=>fails(grade('empty',item.oracle_ref,cwd=>replace(cwd,viewer,'html={content.text}','html={""}'))),60000);
test('same-origin sandbox is rejected',()=>fails(grade('unsafe-origin',item.oracle_ref,cwd=>replace(cwd,frame,'        sandbox="allow-scripts"','        sandbox="allow-scripts allow-same-origin"'))),60000);
test('source toggle must work',()=>fails(grade('no-source-toggle',item.oracle_ref,cwd=>replace(cwd,viewer,'onClick={() => setShowRendered((v) => !v)}','onClick={() => {}}'))),60000);
test('missing CSP is rejected',()=>fails(grade('no-csp',item.oracle_ref,cwd=>replace(cwd,frame,'wrapHtmlForSandbox(html, { theme })','html'))),60000);
test('sandbox token whitespace is equivalent',()=>passes(grade('equivalent',item.oracle_ref,cwd=>replace(cwd,frame,'        sandbox="allow-scripts"','        sandbox="  allow-scripts  "'))),60000);
test('commented payload is not content',()=>fails(grade('comment-payload',item.oracle_ref,cwd=>replace(cwd,frame,'srcDoc={srcDoc}','srcDoc={"<!-- " + srcDoc.replaceAll("-->", "") + " -->"}'))),60000);
test('CSP comment is not a policy',()=>fails(grade('fake-csp',item.oracle_ref,cwd=>replace(cwd,frame,'srcDoc={srcDoc}',`srcDoc={"<!-- default-src 'none'; connect-src 'none'; form-action 'none' -->" + html}`))),60000);
test('ordinary Markdown must survive',()=>fails(grade('preserved-markdown',item.oracle_ref,cwd=>replace(cwd,viewer,'            {renderedText}\n          </MemoizedReactMarkdown>','            {""}\n          </MemoizedReactMarkdown>'))),60000);
test('equivalent default-selection implementation passes',()=>passes(grade('equivalent-inline',item.oracle_ref,cwd=>replace(cwd,'lib/utils/html-sandbox.ts','return hasHumanRenderMarker(text) || looksLikeFullHtmlDocument(text);','return /<!doctype\\s+html\\b|<html[\\s>]|<head[\\s>]|<body[\\s>]|screenpipe:render=human/i.test(text);'))),60000);
test('missing component is a setup error',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,app,viewer)));expect(r.status).toBe(1);expect(r.stderr).toMatch(/ModuleNotFound|Unhandled error/);expect(r.stdout).not.toContain('EVAL_OBSERVATIONS');},60000);
