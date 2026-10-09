// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..'),app='apps/screenpipe-app-tauri';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-manual-grant-payment-prompts');
const root=mkdtempSync(join(tmpdir(),'manual-grant-calibration-'));
const entitlement=`${app}/lib/app-entitlement.ts`,trial=`${app}/lib/first-run/trial-activation.ts`,card=`${app}/lib/card-ask/gating.ts`;
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const show=(ref,path)=>execFileSync('git',['show',`${ref}:${path}`],{cwd:repo});
function edit(cwd,path,from,to){const f=join(cwd,path),s=readFileSync(f,'utf8');expect(s.split(from)).toHaveLength(2);writeFileSync(f,s.replace(from,to));}
function grade(name,ref=item.oracle_ref,mutate=()=>{}){
 const cwd=join(root,name);mkdirSync(cwd);
 execFileSync('tar',['-x','-C',cwd],{input:execFileSync('git',['archive',ref,'--',`${app}/lib`,`${app}/tsconfig.json`],{cwd:repo,maxBuffer:64*1024*1024})});
 for(const f of item.grader.fixtures){const dest=join(cwd,f.destination_path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(import.meta.dir,f.local_path)));}
 for(const link of item.grader_dependency_links)symlinkSync(join(repo,link.source_path),join(cwd,link.destination_path),'dir');
 mutate(cwd);
 const r=spawnSync('/bin/bash',['-c',item.grader.command],{cwd,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{PATH:process.env.PATH,HOME:cwd,CI:'true',TZ:'UTC',NO_COLOR:'1'}});
 if(process.env.EVAL_CALIBRATION_RESULTS){const out=resolve(process.env.EVAL_CALIBRATION_RESULTS);mkdirSync(out,{recursive:true});writeFileSync(join(out,name+'.stdout'),r.stdout||'');writeFileSync(join(out,name+'.stderr'),r.stderr||'');writeFileSync(join(out,name+'.json'),JSON.stringify({ref,command:item.grader.command,exit:r.status,signal:r.signal,error:r.error?.message??null},null,2));}
 expect(r.error).toBeUndefined();expect(r.signal).toBeNull();return r;
}
function passes(r){expect(r.status).toBe(0);expect(r.stdout).toContain('22 passed');expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import/);}
function fails(r){expect(r.status).toBe(1);expect(r.stderr).toMatch(/AssertionError/);expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Cannot find module/);}
test('parent fails four grant outcomes and preserves eighteen',()=>{const r=grade('known_broken',item.base_ref);fails(r);expect(r.stdout).toContain('4 failed | 18 passed');},60000);
test('historical fix passes',()=>passes(grade('known_correct')),60000);
test('current source passes',()=>passes(grade('current','HEAD')),60000);
test('declared source-only oracle repairs parent',()=>passes(grade('oracle_only',item.base_ref,cwd=>{for(const p of item.oracle_paths)writeFileSync(join(cwd,p),show(item.oracle_ref,p));})),60000);
test('equivalent period comparison passes',()=>passes(grade('preserved_behavior',item.oracle_ref,cwd=>edit(cwd,entitlement,'periodEnd > Date.now()','Date.now() < periodEnd'))),60000);
test('unused correct source cannot mask broken callers',()=>fails(grade('bypass',item.base_ref,cwd=>writeFileSync(join(cwd,`${app}/lib/unused-entitlement.ts`),show(item.oracle_ref,entitlement)))),60000);
test('blanket grant exemption fails',()=>fails(grade('blanket',item.oracle_ref,cwd=>edit(cwd,entitlement,'const periodEnd = parseEntitlementTime(entitlement?.current_period_end);','return true;\n const periodEnd = parseEntitlementTime(entitlement?.current_period_end);'))),60000);
test('repairing only trial eligibility fails card behavior',()=>fails(grade('trial_only',item.oracle_ref,cwd=>edit(cwd,card,'if (hasActiveManualSubscriptionGrant(user)) return false;',''))),60000);
test('repairing only card eligibility fails trial behavior',()=>fails(grade('card_only',item.oracle_ref,cwd=>edit(cwd,trial,'if (hasActiveManualSubscriptionGrant(user)) return true;',''))),60000);
test('expired grant exemption fails',()=>fails(grade('expired',item.oracle_ref,cwd=>edit(cwd,entitlement,'periodEnd > Date.now()','true'))),60000);
test('missing source is setup error, not behavior evidence',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,trial)));expect(r.status).toBe(1);expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/);expect(r.stderr).not.toMatch(/AssertionError/);},60000);
