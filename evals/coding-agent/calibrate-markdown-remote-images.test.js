// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..'), app = 'apps/screenpipe-app-tauri';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'app-markdown-remote-images');
const markdown = `${app}/components/markdown.tsx`, block = `${app}/components/chat/markdown-block.tsx`;
const notes = `${app}/components/meeting-notes/note-editor.tsx`;
// The first fix: markdown images only, with a raw-string media gate.
const PREVIOUS_FIX = '7ee2e6ef078200f9781a98c39347d7c8f48c7663';
// The second fix: notes blocked remote images, but a copied one pasted back as text.
const SECOND_FIX = '359ac0c2512578a972ba07c09e895725d5021b6c';
// The third fix: a copied blocked image pasted back, but pasting part of a note
// renamed and resized its embedded images, and a later update could keep
// showing an old picture where a blocked image now was.
const THIRD_FIX = 'bbf239eaa5626876e48b30e8cc04b1e4c1187c1e';
const root = mkdtempSync(join(tmpdir(), 'markdown-remote-images-calibration-')), archives = new Map();
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
  for (const link of item.grader_dependency_links) { const dest = join(cwd, link.destination_path); mkdirSync(dirname(dest),{recursive:true}); symlinkSync(join(repo,link.source_path),dest,'dir'); }
  mutate(cwd);
  const r = spawnSync('/bin/bash', ['-c', item.grader.command], {cwd, encoding:'utf8', timeout:120000, maxBuffer:4*1024*1024, env:{PATH:process.env.PATH, HOME:cwd, CI:'true', TZ:'UTC', NO_COLOR:'1'}});
  if (receipts) { mkdirSync(receipts,{recursive:true}); writeFileSync(join(receipts, name+'.stdout'), r.stdout||''); writeFileSync(join(receipts,name+'.stderr'),r.stderr||''); writeFileSync(join(receipts,name+'.json'),JSON.stringify({ref,command:item.grader.command,exit_code:r.status,signal:r.signal,error:r.error?.message},null,2)); }
  expect(r.error).toBeUndefined(); expect(r.signal).toBeNull(); return r;
}
// Behavior failures surface as chai AssertionErrors or jest-dom matcher errors.
const BEHAVIOR_FAILURE = /AssertionError|Error: expect\(/;
function passes(r) { expect(r.status).toBe(0); expect(r.stdout).toContain('64 passed'); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught/); }
function fails(r) { expect(r.status).toBe(1); expect(r.stderr).toMatch(BEHAVIOR_FAILURE); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Failed to load url|Cannot find module/); }
test('parent fails fifty-seven remote outcomes and preserves seven local files', () => { const r = grade('parent', item.base_ref); fails(r); expect(r.stdout).toContain('57 failed | 7 passed'); }, 120000);
test('previous markdown-only fix fails media-path, alt-text and note outcomes', () => { const r = grade('previous-fix', PREVIOUS_FIX); fails(r); expect(r.stdout).toContain('16 failed | 48 passed'); }, 120000);
const NOTE_OUTCOMES = ['copied and pasted into a note', 'arrives with a later update'];
test('second fix fails the note copy and later-update outcomes', () => { const r = grade('second-fix', SECOND_FIX); fails(r); expect(r.stdout).toContain('2 failed | 62 passed'); for (const name of NOTE_OUTCOMES) expect(r.stderr).toContain(name); }, 120000);
test('third fix fails the note copy and later-update outcomes', () => { const r = grade('third-fix', THIRD_FIX); fails(r); expect(r.stdout).toContain('2 failed | 62 passed'); for (const name of NOTE_OUTCOMES) expect(r.stderr).toContain(name); }, 120000);
test('historical reference passes every outcome', () => passes(grade('reference')), 120000);
test('current caller passes every outcome', () => passes(grade('current', 'HEAD')), 120000);
test('equivalent alt-text element passes', () => passes(grade('equivalent', item.oracle_ref, cwd => replace(cwd, markdown, 'return <ImageAltText alt={alt} />;', 'return alt ? <em>{alt}</em> : null;'))), 120000);
test('plain remote img fallback fails', () => fails(grade('img-fallback', item.oracle_ref, cwd => replace(cwd, markdown, 'return <ImageAltText alt={alt} />;', 'return <img src={src} alt={alt || ""} />;'))), 120000);
test('re-allowed picture and source fail', () => fails(grade('picture', item.oracle_ref, cwd => replace(cwd, block, '...(defaultSchema.tagNames ?? []).filter((tag) => tag !== "picture" && tag !== "source"),', '...(defaultSchema.tagNames ?? []),'))), 120000);
const MEDIA_GATE = 'return isMediaFilePath(path) && /^(?:\\/|~[\\\\/]|[A-Za-z]:[\\\\/])(?![\\\\/])/.test(path);';
test('extension-only media gate fails', () => fails(grade('media-gate', item.oracle_ref, cwd => replace(cwd, markdown, MEDIA_GATE, 'return isMediaFilePath(path);'))), 120000);
test('media gate that allows a second leading separator fails', () => fails(grade('share-prefix', item.oracle_ref, cwd => replace(cwd, markdown, MEDIA_GATE, MEDIA_GATE.replace('(?![\\\\/])', '')))), 120000);
test('network-share paths treated as local fail', () => fails(grade('network-share', item.oracle_ref, cwd => replace(cwd, markdown, 'if (/^\\/(?![\\\\/])/.test(candidate)) {', 'if (candidate.startsWith("/")) {'))), 120000);
test('blanket image removal fails preserved local files', () => fails(grade('no-images', item.oracle_ref, cwd => replace(cwd, markdown, '    img({ src, alt }) {\n      if (src && isLocalMediaPath(src)) {', '    img({ src, alt }) {\n      if (src || !src) return null;\n      if (src && isLocalMediaPath(src)) {'))), 120000);
test('note editor that renders any image source fails', () => fails(grade('note-any-image', item.oracle_ref, cwd => replace(cwd, notes, 'return typeof src === "string" && src.startsWith("data:image/");', 'return typeof src === "string";'))), 120000);
test('note editor that deletes remote images from the note fails', () => fails(grade('note-drops-images', item.oracle_ref, cwd => replace(cwd, notes, '  renderHTML(props) {', '  parseHTML() {\n    return [{ tag: \'img[src^="data:"]\' }];\n  },\n\n  renderHTML(props) {'))), 120000);
test('note editor that takes over pastes of embedded images fails', () => fails(grade('note-paste-takeover', item.oracle_ref, cwd => replace(cwd, notes, 'htmlImageSources.every(isEmbeddedImageSource)', 'htmlImageSources.length === 0'))), 120000);
test('note image view reused for a different source fails', () => fails(grade('note-stale-view', item.oracle_ref, cwd => replace(cwd, notes, 'node.attrs.src === props.node.attrs.src && Boolean(parentUpdate?.(node, ...rest))', 'Boolean(parentUpdate?.(node, ...rest))'))), 120000);
test('unused correct renderer cannot hide broken active caller', () => fails(grade('unused', item.oracle_ref, cwd => {
  writeFileSync(join(cwd, `${app}/unused-correct-markdown.tsx`), readFileSync(join(cwd, markdown)));
  writeFileSync(join(cwd, markdown), execFileSync('git', ['show', `${item.base_ref}:${markdown}`], {cwd: repo}));
})), 120000);
test('missing renderer is setup failure', () => { const r = grade('missing', item.oracle_ref, cwd => rmSync(join(cwd, markdown))); expect(r.status).toBe(1); expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/); expect(r.stderr).not.toMatch(BEHAVIOR_FAILURE); }, 120000);
