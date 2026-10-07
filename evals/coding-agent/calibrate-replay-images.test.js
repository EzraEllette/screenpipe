// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..'), app = 'apps/screenpipe-app-tauri';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'app-replay-unavailable-images');
const hook = `${app}/components/meeting-notes/replay-strip.tsx`;
const root = mkdtempSync(join(tmpdir(), 'replay-images-calibration-')), archives = new Map();
const receipts = process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS;
afterAll(() => rmSync(root, {recursive: true, force: true}));
function replace(cwd, file, from, to) {
  const p = join(cwd, file), text = readFileSync(p, 'utf8');
  expect(text.split(from)).toHaveLength(2);
  writeFileSync(p, text.replace(from, to));
}
function grade(name, ref = item.oracle_ref, mutate = () => {}) {
  const cwd = join(root, name); mkdirSync(cwd);
  if (!archives.has(ref)) {
    // Archive historical frontend source/config, never node_modules, credentials,
    // native build outputs or future source. No evaluated agent runs here.
    const children = execFileSync('git', ['ls-tree', '--name-only', `${ref}:${app}`], {cwd: repo, encoding: 'utf8'}).trim().split('\n');
    const paths = children.filter(n => !['src-tauri', 'public', 'e2e', '.e2e'].includes(n) && !n.startsWith('.env')).map(n => `${app}/${n}`);
    for (const path of ['packages/workflows-ui', 'crates/screenpipe-core/assets']) { if (execFileSync('git', ['ls-tree', ref, path], {cwd:repo, encoding:'utf8'}).trim()) paths.push(path); }
    archives.set(ref, execFileSync('git', ['archive', ref, ...paths], {cwd: repo, maxBuffer: 128 * 1024 * 1024}));
  }
  execFileSync('tar', ['-x', '-C', cwd], {input: archives.get(ref)});
  for (const f of item.grader.fixtures) { const dest = join(cwd, f.destination_path); mkdirSync(dirname(dest), {recursive:true}); writeFileSync(dest, readFileSync(join(import.meta.dir, f.local_path))); }
  symlinkSync(join(repo, app, 'node_modules'), join(cwd, app, 'node_modules'), 'dir');
  mutate(cwd);
  const r = spawnSync('/bin/bash', ['-c', item.grader.command], {cwd, encoding:'utf8', timeout:60000, maxBuffer:4*1024*1024, env:{PATH:process.env.PATH, HOME:cwd, CI:'true', TZ:'UTC', NO_COLOR:'1'}});
  if (receipts) { mkdirSync(receipts,{recursive:true}); writeFileSync(join(receipts, name+'.stdout'), r.stdout||''); writeFileSync(join(receipts,name+'.stderr'),r.stderr||''); writeFileSync(join(receipts,name+'.json'),JSON.stringify({ref,command:item.grader.command,exit_code:r.status,signal:r.signal,error:r.error?.message},null,2)); }
  expect(r.error).toBeUndefined(); expect(r.signal).toBeNull(); return r;
}
function passes(r) { expect(r.status).toBe(0); expect(r.stdout).toContain('6 passed'); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught/); }
function fails(r) { expect(r.status).toBe(1); expect(r.stderr).toMatch(/AssertionError|TestingLibraryElementError: Unable to find an element/); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Failed to load url|Cannot find module/); }
test('parent fails four image recovery outcomes and preserves two',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('4 failed | 2 passed');},60000);
test('reference passes six outcomes',()=>passes(grade('reference')),60000);
test('current source passes six outcomes',()=>passes(grade('current','HEAD')),60000);
test('equivalent private state names are accepted',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{const p=join(cwd,hook);writeFileSync(p,readFileSync(p,'utf8').replaceAll('unavailableFrameIds','failedImages').replaceAll('setUnavailableFrameIds','setFailedImages').replaceAll('markFrameUnavailable','evictImage'));})),60000);
test('unused repair cannot hide active broken code',()=>fails(grade('bypass',item.oracle_ref,cwd=>{writeFileSync(join(cwd,'unused-correct.tsx'),readFileSync(join(cwd,hook)));writeFileSync(join(cwd,hook),execFileSync('git',['show',`${item.base_ref}:${hook}`],{cwd:repo}));})),60000);
test('active image handler cannot be omitted',()=>fails(grade('active-handler',item.oracle_ref,cwd=>replace(cwd,hook,'onError={() => markFrameUnavailable(activeFrame.frameId)}',''))),60000);
test('thumbnail handler cannot be omitted',()=>fails(grade('thumbnail-handler',item.oracle_ref,cwd=>replace(cwd,hook,'onError={() => markFrameUnavailable(f.frameId)}',''))),60000);
test('unavailable state must reset for a new range',()=>fails(grade('no-reset',item.oracle_ref,cwd=>replace(cwd,hook,'    setUnavailableFrameIds(new Set());',''))),60000);
test('all images cannot be suppressed',()=>fails(grade('blanket',item.oracle_ref,cwd=>replace(cwd,hook,'() => frames.filter((f) => !unavailableFrameIds.has(f.frameId)),','() => [],'))),60000);
test('frame count must reflect available images',()=>fails(grade('stale-count',item.oracle_ref,cwd=>replace(cwd,hook,'${renderableFrames.length} frames','${frames.length} frames'))),60000);
test('timeline handoff remains available without frames',()=>fails(grade('no-navigation',item.oracle_ref,cwd=>replace(cwd,hook,'router.push("/home?section=timeline");',''))),60000);
test('missing component remains a setup error',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,hook)));expect(r.status).toBe(1);expect(r.stdout).toContain('no tests');expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/);},60000);
