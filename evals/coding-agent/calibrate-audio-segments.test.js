// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { classifyGraderError } from './grader-outcome.mjs';
const repo = resolve(import.meta.dir, '../..');
const item = JSON.parse(readFileSync(join(import.meta.dir,'cases.json'))).cases.find(c=>c.id==='app-audio-distinct-segment-search');
const source = item.oracle_paths[0];
const git = (...args) => execFileSync('git',args,{cwd:repo,encoding:'utf8',maxBuffer:128*1024*1024});
const parent=git('show',`${item.base_ref}:${source}`), fixed=git('show',`${item.oracle_ref}:${source}`);
const fixture=readFileSync(join(import.meta.dir,'graders/audio-segment-search.rs'));
const hash=x=>createHash('sha256').update(x).digest('hex');
function change(text,from,to,count=1){expect(text.split(from).length-1).toBe(count);return text.split(from).join(to);}
test('audio segment grader rejects broken, bypass and preserved-behavior regressions',()=>{
 const root=mkdtempSync(join(tmpdir(),'audio-segment-calibration-'));
 try {
  const archive=join(root,'source.tar');
  execFileSync('git',['archive','--output',archive,item.base_ref],{cwd:repo,timeout:30000});
  execFileSync('tar',['-xf',archive,'-C',root],{timeout:30000});
  rmSync(archive);
  writeFileSync(join(root,'crates/screenpipe-db/tests/eval_audio_segments.rs'),fixture);
  const controls=[
   ['parent',parent,'fail'],['reference',fixed,'pass'],
   ['equivalent',change(fixed,'GROUP BY audio_transcriptions.id ORDER BY','GROUP BY audio_transcriptions.id, audio_transcriptions.audio_chunk_id ORDER BY'),'pass'],
   ['unused',parent,'fail'],
   ['text-grouping',change(fixed,'GROUP BY audio_transcriptions.id ORDER BY','GROUP BY audio_transcriptions.transcription ORDER BY'),'fail'],
   ['missing-tie-break',change(fixed,', audio_transcriptions.id {order_dir} LIMIT',' LIMIT'),'fail'],
   ['tag-split',change(fixed,'GROUP BY audio_transcriptions.id ORDER BY','GROUP BY audio_transcriptions.id, tags.id ORDER BY'),'fail'],
   ['ignore-device',change(fixed,'query_builder = query_builder.bind(dev);','query_builder = query_builder.bind("Synthetic Output");'),'fail'],
   ['missing',null,'error'],
  ];
  for(const [name,text,expected] of controls){
   if(text===null)rmSync(join(root,source));else writeFileSync(join(root,source),text);
   if(name==='unused')writeFileSync(join(root,'unused-correct.rs'),fixed);else rmSync(join(root,'unused-correct.rs'),{force:true});
   // Calibration alone reuses its own target. No evaluated agent runs here.
   const result=spawnSync('/bin/bash',['-c',item.grader.command],{cwd:root,encoding:'utf8',timeout:item.grader.timeout_seconds*1000,maxBuffer:8*1024*1024});
   const kind=classifyGraderError(result);const observed=result.error||result.signal||kind?'error':result.status===0?'pass':'fail';
   if(process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS){const dir=resolve(process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,`${name}.json`),JSON.stringify({expected,observed,command:item.grader.command,status:result.status,signal:result.signal,error:result.error?.message??null,error_kind:kind,source_sha256:text===null?null:hash(text),fixture_sha256:hash(fixture),stdout:result.stdout,stderr:result.stderr},null,2));}
   expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(observed).toBe(expected);
   if(expected==='pass')expect(result.stdout).toContain('6 passed; 0 failed');
   if(expected==='fail'){expect(result.status).toBe(101);expect(result.stdout).toContain('test result: FAILED.');}
   if(name==='parent')expect(result.stdout).toContain('3 passed; 3 failed');
   if(name==='missing')expect(kind).toBe('rust_compile_error');
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},1500000);
