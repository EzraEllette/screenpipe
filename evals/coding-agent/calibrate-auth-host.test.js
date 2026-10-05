// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..'),path='apps/screenpipe-app-tauri/lib/auth-guard.tsx';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-cloud-auth-host-boundary');
const source=ref=>execFileSync('git',['show',`${ref}:${path}`],{cwd:repo,encoding:'utf8'});
const parent=source(item.base_ref),reference=source(item.oracle_ref),fixture=readFileSync(join(import.meta.dir,'graders/auth-host.fixture.tsx.txt'));
const root=mkdtempSync(join(tmpdir(),'auth-host-calibration-'));afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,body){
 const cwd=join(root,name);mkdirSync(join(cwd,dirname(path)),{recursive:true});if(body!==null)writeFileSync(join(cwd,path),body);
 if(name==='unused')writeFileSync(join(cwd,'unused-correct-module.tsx'),reference);
 writeFileSync(join(cwd,'auth-host.eval.test.tsx'),fixture);
 const args=['--no-env-file','test','auth-host.eval.test.tsx'];const r=spawnSync(process.execPath,args,{cwd,encoding:'utf8',timeout:15000,env:{PATH:dirname(process.execPath)}});
 if(process.env.EVAL_CALIBRATION_RESULTS_DIR){const d=process.env.EVAL_CALIBRATION_RESULTS_DIR;mkdirSync(d,{recursive:true});for(const k of ['stdout','stderr'])writeFileSync(join(d,name+'.'+k),r[k]??'');writeFileSync(join(d,name+'.json'),JSON.stringify({command:[process.execPath,...args],exit:r.status,error:r.error?.message??null,signal:r.signal},null,2)+'\n');}return r;
}
function pass(r){expect(r.error).toBeUndefined();expect(r.status).toBe(0);expect(r.stderr).toContain('11 pass');expect(r.stderr).toContain('0 fail');}
function fail(r){expect(r.error).toBeUndefined();expect(r.status).toBe(1);expect(r.stderr).toContain('error: expect(received)');expect(r.stderr).not.toContain('GRADER_SETUP_ERROR');}
function replace(s,a,b){expect(s.split(a)).toHaveLength(2);return s.replace(a,b);}
test('parent fails six unwanted clears with five preserved outcomes',()=>{const r=grade('parent',parent);fail(r);expect(r.stderr).toContain('5 pass');expect(r.stderr).toContain('6 fail');});
test('historical fix passes',()=>pass(grade('reference',reference)));
test('current interceptor passes',()=>pass(grade('current',source('HEAD'))));
test('equivalent host matching passes',()=>pass(grade('equivalent',replace(reference,'host.endsWith(".screenpi.pe")','/\\.screenpi\\.pe$/.test(host)').replace('host.endsWith(".screenpipe.com")','/\\.screenpipe\\.com$/.test(host)'))));
test('unused correct module cannot hide broken interceptor',()=>fail(grade('unused',parent)));
test('blanket sign-out suppression loses genuine expiry',()=>fail(grade('blanket',replace(reference,'if (isScreenpipeApi(url) && (res.status === 401 || res.status === 403))','if (false)'))));
test('reconstructed response loses response identity',()=>fail(grade('response',replace(reference,'return res;','return new Response(null, { status: res.status });'))));
test('lost request options are rejected',()=>fail(grade('arguments',replace(reference,'originalFetch.call(this, input, init)','originalFetch.call(this, input)'))));
test('missing source is infrastructure, not intended regression',()=>{const r=grade('missing',null);expect(r.status).toBe(1);expect(r.stderr).toContain('0 pass');expect(r.stderr).not.toContain('error: expect(received)');expect(r.stderr).toMatch(/ModuleNotFound|File not found|GRADER_SETUP_ERROR/);});
