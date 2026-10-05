// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyGraderError } from './grader-outcome.mjs';

const repo=resolve(import.meta.dir,'../..');
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(x=>x.id==='app-transcription-nova-language');
const handler='packages/ai-gateway/src/handlers/transcription.ts';
const service='packages/ai-gateway/src/services/transcription-ab.ts';
const cors='packages/ai-gateway/src/utils/cors.ts';
const show=(ref,path)=>execFileSync('git',['show',`${ref}:${path}`],{cwd:repo,encoding:'utf8'});
const broken=show(item.base_ref,service), fixed=show(item.oracle_ref,service);
const root=mkdtempSync(join(tmpdir(),'transcription-language-calibration-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function grade(name, source, ref=item.base_ref, missing=false) {
  const workspace=join(root,name);
  const write=(path,data)=>{mkdirSync(dirname(join(workspace,path)),{recursive:true});writeFileSync(join(workspace,path),data);};
  if(!missing)write(handler,show(ref,handler));
  write(service,source); write(cors,show(ref,cors));
  write('packages/ai-gateway/src/providers/vertex.ts','export class VertexAIProvider { constructor(){throw Error("unexpected alternate provider")} }');
  const fixture=item.grader.fixtures[0];write(fixture.destination_path,readFileSync(join(import.meta.dir,fixture.local_path),'utf8'));
  const result=spawnSync(process.execPath,['--no-env-file','test',fixture.destination_path],{cwd:workspace,encoding:'utf8',timeout:30000,env:{PATH:dirname(process.execPath)}});
  if(process.env.TRANSCRIPTION_CALIBRATION_RESULTS){const out=resolve(process.env.TRANSCRIPTION_CALIBRATION_RESULTS);mkdirSync(out,{recursive:true});writeFileSync(join(out,name+'.stdout'),result.stdout??'');writeFileSync(join(out,name+'.stderr'),result.stderr??'');writeFileSync(join(out,name+'.json'),JSON.stringify({status:result.status,signal:result.signal,error:result.error?.message??null,classification:classifyGraderError(result)}));}
  return result;
}
function pass(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(0);expect(r.stderr).toContain('12 pass');}
function fail(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toContain('expect(received)');expect(classifyGraderError(r)).toBeNull();}
function patch(anchor,replacement){expect(fixed.split(anchor)).toHaveLength(2);return fixed.replace(anchor,replacement);}
test('broken caller fails nine language outcomes and preserves three',()=>{const r=grade('parent',broken);fail(r);expect(r.stderr).toContain('9 fail');expect(r.stderr).toContain('3 pass');},40000);
test('historical service-only repair passes actual handler outcomes',()=>pass(grade('reference',fixed)),40000);
test('current source preserves the contract',()=>pass(grade('current',show('HEAD',service),'HEAD')),40000);
test('unused complete correct helper cannot hide the broken call',()=>{const helper=fixed.slice(fixed.indexOf('export function deepgramLanguageQuery'),fixed.indexOf('export async function callDeepgram'));fail(grade('unused',broken+'\n'+helper));},40000);
test('always English cannot replace language selection',()=>fail(grade('english',patch('deepgramLanguageQuery(req.languages)',"'&language=en'"))),40000);
test('always multilingual cannot replace a single selected language',()=>fail(grade('multi',patch('deepgramLanguageQuery(req.languages)',"'&language=multi'"))),40000);
test('audio bytes must survive the repaired request',()=>fail(grade('audio',fixed.replace('body: req.audioBuffer,','body: new ArrayBuffer(0),'))),40000);
test('equivalent inline language construction passes',()=>pass(grade('equivalent',patch('deepgramLanguageQuery(req.languages)',"((codes)=>'&language='+encodeURIComponent(codes.length===1?codes[0]:'multi'))(req.languages.map(x=>x.trim().toLowerCase()).filter(x=>x&&x!=='true'&&x!=='false'))"))),40000);
test('missing active handler is an infrastructure error',()=>{const r=grade('missing',fixed,item.base_ref,true);expect(r.status).not.toBe(0);expect(r.stderr).toContain('Cannot find module');expect(classifyGraderError(r)).toBe('bun_unhandled_error');expect(r.stderr).not.toContain('expect(received)');},40000);
test('service syntax failure is an infrastructure error',()=>{const r=grade('syntax','export const = ;');expect(r.status).not.toBe(0);expect(classifyGraderError(r)).toBe('bun_unhandled_error');expect(r.stderr).not.toContain('expect(received)');},40000);

test('equivalent Request transport preserves the same observable request',()=>{const source=patch('const resp = await fetch(url, {','const resp = await fetch(new Request(url, {').replace('signal: AbortSignal.timeout(180_000),\n      });','signal: AbortSignal.timeout(180_000),\n      }));');pass(grade('request',source));},40000);
