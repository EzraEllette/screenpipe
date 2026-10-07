// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..'), app = 'apps/screenpipe-app-tauri';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'app-chat-saved-user-recency');
const hook = `${app}/lib/chat-storage.ts`;
const root = mkdtempSync(join(tmpdir(), 'chat-recency-calibration-')), archives = new Map();
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
function passes(r) { expect(r.status).toBe(0); expect(r.stdout).toContain('9 passed'); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught/); }
function fails(r) { expect(r.status).toBe(1); expect(r.stderr).toMatch(/AssertionError|TestingLibraryElementError: Unable to find an element/); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Failed to load url|Cannot find module/); }
test('parent fails three recency outcomes and preserves six',()=>{const r=grade('parent',item.base_ref);fails(r);expect(r.stdout).toContain('3 failed | 6 passed');},60000);
test('reference passes nine outcomes',()=>passes(grade('reference')),60000);
test('current source passes nine outcomes',()=>passes(grade('current','HEAD')),60000);
test('equivalent private timestamp names are accepted',()=>passes(grade('equivalent',item.oracle_ref,cwd=>{const p=join(cwd,hook);writeFileSync(p,readFileSync(p,'utf8').replaceAll('newestUserMessageAt','latestNumericUserTime').replaceAll('persistedLastUserMessageAt','storedUserTime'));})),60000);
test('unused repair cannot hide broken listing',()=>fails(grade('bypass',item.oracle_ref,cwd=>{writeFileSync(join(cwd,'unused-correct.ts'),readFileSync(join(cwd,hook)));writeFileSync(join(cwd,hook),execFileSync('git',['show',`${item.base_ref}:${hook}`],{cwd:repo}));})),60000);
test('a newer saved marker must survive',()=>fails(grade('newer-marker',item.oracle_ref,cwd=>replace(cwd,hook,'Math.max(persistedLastUserMessageAt ?? 0, newestUserMessageAt)','newestUserMessageAt'))),60000);
test('assistant activity must not advance user recency',()=>fails(grade('assistant-time',item.oracle_ref,cwd=>replace(cwd,hook,'m?.role === "user" && typeof m.timestamp === "number"','typeof m?.timestamp === "number"'))),60000);
test('transcript array order cannot choose the wrong time',()=>fails(grade('last-array-item',item.oracle_ref,cwd=>replace(cwd,hook,'newestUserMessageAt == null || m.timestamp > newestUserMessageAt','true'))),60000);
test('listing must not hide the affected conversation',()=>fails(grade('blanket',item.oracle_ref,cwd=>replace(cwd,hook,'if (!conv || typeof conv.id !== "string") return null;','return null;'))),60000);
test('conversation title must survive metadata repair',()=>fails(grade('title-loss',item.oracle_ref,cwd=>replace(cwd,hook,'title: typeof conv.title === "string" ? conv.title : "untitled",','title: "lost",'))),60000);
test('missing storage source is a setup error',()=>{const r=grade('missing',item.oracle_ref,cwd=>rmSync(join(cwd,hook)));expect(r.status).toBe(1);expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/);expect(r.stdout+r.stderr).not.toContain('AssertionError');},60000);
