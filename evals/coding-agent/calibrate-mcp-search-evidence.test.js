// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..');
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'))).cases.find(c=>c.id==='app-mcp-search-source-evidence');
const root=mkdtempSync(join(tmpdir(),'mcp-search-evidence-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,ref,mutate=()=>{}){
 const cwd=join(root,name);mkdirSync(cwd);execFileSync('tar',['-xf','-','-C',cwd],{input:execFileSync('git',['archive',ref,'packages/screenpipe-mcp'],{cwd:repo,maxBuffer:24*1024*1024})});
 const pkg=join(cwd,'packages/screenpipe-mcp');symlinkSync(join(repo,'packages/screenpipe-mcp/node_modules'),join(pkg,'node_modules'),'dir');
 writeFileSync(join(pkg,'src/eval-evidence.test.ts'),readFileSync(join(import.meta.dir,'graders/mcp-search-evidence.fixture.ts.txt')));mutate(pkg);
 const home=join(cwd,'home');mkdirSync(home);
 const r=spawnSync(process.env.NODE_BIN||'node',['node_modules/vitest/vitest.mjs','run','src/eval-evidence.test.ts'],{cwd:pkg,encoding:'utf8',timeout:60_000,maxBuffer:4*1024*1024,env:{PATH:process.env.PATH,HOME:home,CI:'true',TZ:'UTC',SCREENPIPE_MCP_TELEMETRY_DISABLED:'1',DO_NOT_TRACK:'1',SCREENPIPE_API_URL:'http://127.0.0.1:1'}});
 if(process.env.MCP_EVIDENCE_CALIBRATION_RESULTS){mkdirSync(process.env.MCP_EVIDENCE_CALIBRATION_RESULTS,{recursive:true});writeFileSync(join(process.env.MCP_EVIDENCE_CALIBRATION_RESULTS,name+'.json'),JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message??null,stdout:r.stdout,stderr:r.stderr},null,2)+'\n');}
 return r;
}
const clean=s=>s.replace(/\x1b\[[0-9;]*m/g,'');
function pass(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status,r.stdout+r.stderr).toBe(0);expect(clean(r.stdout)).toContain('9 passed');}
function fail(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('AssertionError');expect(r.stderr).not.toMatch(/Cannot find module|Failed to load url/);}
function edit(pkg,file,from,to){const p=join(pkg,'src',file),s=readFileSync(p,'utf8');expect(s.split(from)).toHaveLength(2);writeFileSync(p,s.replace(from,to));}
test('broken HTTP caller fails five outcomes and preserves four',()=>{const r=grade('parent',item.base_ref);fail(r);expect(clean(r.stdout)).toContain('5 failed');expect(clean(r.stdout)).toContain('4 passed');});
test('historical reference passes all nine HTTP outcomes',()=>pass(grade('reference',item.oracle_ref)));
test('current source preserves the public search contract',()=>pass(grade('current','HEAD')));
test('unused correct helper does not repair the broken HTTP caller',()=>fail(grade('unused',item.base_ref,pkg=>writeFileSync(join(pkg,'src/unused-search-result.ts'),execFileSync('git',['show',`${item.oracle_ref}:packages/screenpipe-mcp/src/search-result.ts`],{cwd:repo})))));
test('equivalent truncation expression is accepted',()=>pass(grade('equivalent',item.oracle_ref,pkg=>edit(pkg,'search-result.ts','const left = Math.floor(cap / 2);','const left = Math.trunc(cap / 2);'))));
test('wrong source identifiers cannot pass',()=>fail(grade('wrong-id',item.oracle_ref,pkg=>edit(pkg,'search-result.ts','? value : undefined','? value + 1 : undefined'))));
test('unbounded default text cannot pass',()=>fail(grade('unbounded',item.oracle_ref,pkg=>edit(pkg,'search-result.ts','if (cap === 0 || text.length <= cap) return text;','if (true) return text;'))));
test('blanket empty response cannot pass',()=>fail(grade('blanket',item.oracle_ref,pkg=>edit(pkg,'http-server.ts','const results = data.data || [];','const results = [];'))));
test('missing HTTP module is setup failure rather than intended regression',()=>{const r=grade('missing',item.oracle_ref,pkg=>rmSync(join(pkg,'src/http-server.ts')));expect(r.status).not.toBe(0);expect(r.stderr).toMatch(/Cannot find module|Failed to load url/);expect(r.stderr).not.toContain('AssertionError');});
