// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
const repo=resolve(import.meta.dir,"../..");
const item=JSON.parse(readFileSync(join(import.meta.dir,"cases.json"),"utf8")).cases.find(x=>x.id==="ai-gateway-wif-token-retry");
const path="packages/ai-gateway/src/providers/vertex.ts";
const show=(ref,p)=>execFileSync("git",["show",`${ref}:${p}`],{cwd:repo,encoding:"utf8"});
const broken=show(item.base_ref,path),fixed=show(item.oracle_ref,path);
const root=mkdtempSync(join(tmpdir(),"wif-retry-calibration-"));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name,source,extra) {
 const workspace=join(root,name);
 const write=(p,data)=>{mkdirSync(dirname(join(workspace,p)),{recursive:true});writeFileSync(join(workspace,p),data);};
 if(source!==null)write(path,source);
 for(const p of ["packages/ai-gateway/src/providers/base.ts","packages/ai-gateway/src/types.ts"])write(p,show(item.base_ref,p));
 if(extra)write("packages/ai-gateway/src/providers/unused-repair.ts",extra);
 const fixture=item.grader.fixtures[0];mkdirSync(dirname(join(workspace,fixture.destination_path)),{recursive:true});copyFileSync(join(import.meta.dir,fixture.local_path),join(workspace,fixture.destination_path));
 const r=spawnSync(process.execPath,["--no-env-file","test",fixture.destination_path],{cwd:workspace,encoding:"utf8",timeout:30000,env:{PATH:dirname(process.execPath)}});
 if(process.env.WIF_CALIBRATION_RESULTS){const out=resolve(process.env.WIF_CALIBRATION_RESULTS);mkdirSync(out,{recursive:true});writeFileSync(join(out,name+".stdout"),r.stdout??"");writeFileSync(join(out,name+".stderr"),r.stderr??"");writeFileSync(join(out,name+".json"),JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message??null}));}
 return r;
}
function fail(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain("expect(received)");expect(r.stderr).not.toContain("Cannot find module");}
function pass(r){expect(r.error).toBeUndefined();expect(r.status).toBe(0);expect(r.stderr).toContain("14 pass");}
function patch(anchor,replacement){expect(fixed.split(anchor)).toHaveLength(2);return fixed.replace(anchor,replacement);}
test("parent fails eight outcomes and preserves six",()=>{const r=grade("parent",broken);fail(r);expect(r.stderr).toContain("8 fail");expect(r.stderr).toContain("6 pass");},40000);
test("historical reference passes public token outcomes",()=>pass(grade("reference",fixed)),40000);
test("current source preserves the same authentication contract",()=>pass(grade("current",show("HEAD",path))),40000);
test("equivalent retry naming and backoff are accepted",()=>pass(grade("equivalent",fixed.replaceAll("wifFetchWithRetry","exchangeWithRecovery").replace("200 * (attempt + 1) + Math.random() * 150","25 * (attempt + 1)"))),40000);
test("unused correct retry helper cannot hide broken caller",()=>fail(grade("unused",broken,fixed)),40000);
test("only STS retry cannot hide broken impersonation",()=>fail(grade("sts-only",patch("const impResp = await wifFetchWithRetry(","const impResp = await fetch("))),40000);
test("only impersonation retry cannot hide broken STS",()=>fail(grade("iam-only",patch("const stsResp = await wifFetchWithRetry(","const stsResp = await fetch("))),40000);
test("429 cannot bypass transient recovery",()=>fail(grade("no429",patch("resp.status < 500 && resp.status !== 429","resp.status < 500"))),40000);
test("permanent refusal must not retry",()=>fail(grade("retry400",patch("resp.status < 500 && resp.status !== 429","resp.status < 400"))),40000);
test("retry budget stays bounded",()=>fail(grade("overbudget",patch("const MAX = 3;","const MAX = 4;"))),40000);
test("valid cached WIF token avoids new requests",()=>fail(grade("nocache",patch("if (tokenCache && tokenCache.expiresAt > Date.now() + 60000)","if (false && tokenCache && tokenCache.expiresAt > Date.now() + 60000)"))),40000);
test("retry preserves the STS token at impersonation",()=>fail(grade("credential",patch("Authorization: `Bearer ${sts.access_token}`","Authorization: `Bearer synthetic-wrong`"))),40000);
test("blanket refusal cannot replace recovery",()=>fail(grade("deny",patch("public async getAccessToken(): Promise<string> {","public async getAccessToken(): Promise<string> { throw new Error('refused');"))),40000);
test("missing provider is an infrastructure failure",()=>{const r=grade("missing",null);expect(r.status).not.toBe(0);expect(r.stderr).toContain("Cannot find module");expect(r.stderr).not.toContain("expect(received)");},40000);
