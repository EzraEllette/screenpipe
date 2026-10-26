// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Adapter calibration only. The Cargo shim records dispatch and injected bytes;
// actual broken/reference/current behavior is verified separately with Cargo.
const adapter = readFileSync(join(import.meta.dir, 'graders/retention-capture-durable.mjs'), 'utf8');
const fixture = readFileSync(join(import.meta.dir, 'graders/retention-capture-durable.rs.txt'), 'utf8');
const original = 'all_retention_yields_archived_history_to_durable_capture';
const hidden = 'eval_hidden_retention_capture_contract';
const source = body => `#[cfg(test)]\nmod tests {\n${body}\n}\n`;
function run(text, fixtureText = fixture, exit = 0, script = adapter) {
  const root = mkdtempSync(join(tmpdir(), 'retention-adapter-'));
  try {
    for (const path of ['crates/screenpipe-engine/src', '.eval-retention', 'bin']) mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, 'crates/screenpipe-engine/src/retention.rs'), text);
    if (fixtureText !== null) writeFileSync(join(root, '.eval-retention/retention-capture-durable.rs'), fixtureText);
    writeFileSync(join(root, 'adapter.mjs'), script);
    writeFileSync(join(root, 'bin/cargo'), `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync('dispatch.json',JSON.stringify({args:process.argv.slice(2),source:fs.readFileSync('crates/screenpipe-engine/src/retention.rs','utf8')})); process.exit(${exit});\n`);
    chmodSync(join(root, 'bin/cargo'), 0o755);
    const result = spawnSync(process.execPath, ['adapter.mjs'], { cwd: root, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, encoding: 'utf8', timeout: 10000 });
    let dispatch = null;
    try { dispatch = JSON.parse(readFileSync(join(root, 'dispatch.json'), 'utf8')); } catch {}
    return { ...result, dispatch };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
for (const [name, body] of [
  ['absent product test', ''],
  ['empty same-name test', `async fn ${original}() {}`],
  ['weakened same-name test', `async fn ${original}() { let _ = 15; }`],
  ['unrelated preserved test', '#[test] fn ordinary() { assert!(true); }'],
]) test(name, () => {
  const result = run(source(body));
  expect(result.status).toBe(0);
  expect(result.dispatch.args).toEqual(['test', '--locked', '-p', 'screenpipe-engine', hidden, '--', '--nocapture']);
  expect(result.dispatch.source).toContain(body);
  expect(result.dispatch.source).toContain(fixture.replace(`async fn ${original}()`, `async fn ${hidden}()`));
  expect(result.dispatch.source).toContain('retention cleanup must begin processing within 15 seconds');
});
test('does not turn a Cargo failure into success', () => expect(run(source(''), fixture, 101).status).toBe(101));
for (const [name, text, input] of [
  ['reserved collision', source(`async fn ${hidden}() {}`), fixture],
  ['missing test module', 'fn main() {}', fixture],
  ['missing fixture', source(''), null],
  ['malformed fixture', source(''), '// no contract'],
  ['duplicate fixture declarations', source(''), fixture + fixture],
]) test(name, () => {
  const result = run(text, input);
  expect(result.status).not.toBe(0);
  expect(result.dispatch).toBeNull();
});
