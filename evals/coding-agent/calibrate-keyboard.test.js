// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..'), app = 'apps/screenpipe-app-tauri';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'app-timeline-keyboard-filter-freshness');
const hook = `${app}/components/rewind/hooks/use-timeline-keyboard.ts`;
const root = mkdtempSync(join(tmpdir(), 'timeline-keyboard-calibration-')), archives = new Map();
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
function passes(r) { expect(r.status).toBe(0); expect(r.stdout).toContain('12 passed'); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught/); }
function fails(r) { expect(r.status).toBe(1); expect(r.stderr).toMatch(/AssertionError|TestingLibraryElementError: Unable to find an element/); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Failed to load url|Cannot find module/); }
test('parent fails three freshness outcomes and preserves nine',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('3 failed | 9 passed');},60000);
test('reference passes twelve outcomes',()=>passes(grade('reference')),60000);
test('current source passes twelve outcomes',()=>passes(grade('current','HEAD')),60000);
test('equivalent callback names are accepted',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{const p=join(cwd,hook);let s=readFileSync(p,'utf8');s=s.replace('findNextDevice,','findNextDevice: chooseFilteredFrame,');s=s.replaceAll('findNextDevice(prev','chooseFilteredFrame(prev').replace('frames, findNextDevice, setCurrentIndex','frames, chooseFilteredFrame, setCurrentIndex');writeFileSync(p,s);})),60000);
test('unused correct hook cannot hide stale active listener',()=>fails(grade('bypass',item.oracle_ref,cwd=>{writeFileSync(join(cwd,'unused-correct.ts'),readFileSync(join(cwd,hook)));writeFileSync(join(cwd,hook),execFileSync('git',['show',`${item.base_ref}:${hook}`],{cwd:repo}));})),60000);
test('blanket arrow refusal is rejected',()=>fails(grade('blanket',item.oracle_ref,cwd=>replace(cwd,hook,'const handleArrowKeys = (e: KeyboardEvent) => {','const handleArrowKeys = (e: KeyboardEvent) => { return;'))),60000);
test('text editing must retain arrows',()=>fails(grade('input',item.oracle_ref,cwd=>{const p=join(cwd,hook);writeFileSync(p,readFileSync(p,'utf8').replaceAll('target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable','false'));})),60000);
test('open modal must retain arrows',()=>fails(grade('modal',item.oracle_ref,cwd=>{const p=join(cwd,hook);writeFileSync(p,readFileSync(p,'utf8').replaceAll('if (showSearchModal) return;','if (false) return;'));})),60000);
test('playback seek must reach selected timestamp',()=>fails(grade('seek',item.oracle_ref,cwd=>{const p=join(cwd,hook);writeFileSync(p,readFileSync(p,'utf8').replaceAll('if (isPlaying) seekPlayback(new Date(frames[next].timestamp).getTime());','if (isPlaying) void 0;'));})),60000);
test('unmount must remove the active listener',()=>fails(grade('unmount',item.oracle_ref,cwd=>replace(cwd,hook,'return () => window.removeEventListener("keydown", handleArrowKeys);','return () => {};'))),60000);
test('missing hook is setup error',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,hook)));expect(r.status).toBe(1);expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/);expect(r.stdout+r.stderr).not.toContain('AssertionError');},60000);
