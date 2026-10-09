// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..');
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'))).cases.find(c => c.id === 'ai-gateway-null-model-accounting');
const root = mkdtempSync(join(tmpdir(), 'null-model-calibration-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fixture = readFileSync(join(import.meta.dir, 'graders/null-model-accounting.fixture.ts.txt'));
const path = 'packages/ai-gateway/src/services/cost-tracker.ts';
function replaceOne(text, before, after) {
  expect(text.split(before)).toHaveLength(2);
  return text.replace(before, after);
}
function grade(name) {
  const cwd = join(root, name); mkdirSync(cwd);
  const ref = ['parent', 'unused', 'oracle-only'].includes(name) ? item.base_ref : name === 'current' ? 'HEAD' : item.oracle_ref;
  execFileSync('tar', ['-x', '-C', cwd], { input: execFileSync('git', ['archive', ref, 'packages/ai-gateway/src'], { cwd: repo, maxBuffer: 32 * 1024 * 1024 }) });
  const file = join(cwd, path);
  if (name === 'unused' || name === 'oracle-only') writeFileSync(name === 'unused' ? file + '.unused.ts' : file, execFileSync('git', ['show', `${item.oracle_ref}:${path}`], { cwd: repo }));
  let source = readFileSync(file, 'utf8');
  if (name === 'equivalent') source = source.replaceAll("typeof model !== 'string' || model.length === 0", "!(typeof model === 'string' && model.length > 0)");
  if (name === 'free-unknown') source = replaceOne(source, 'return pricing !== null && pricing.input === 0 && pricing.output === 0;', 'return pricing === null || (pricing.input === 0 && pricing.output === 0);');
  if (name === 'blanket-fallback') source = replaceOne(source, 'const pricing = findPricing(model);\n  if (!pricing)', 'const pricing = null;\n  if (!pricing)');
  if (name === 'lost-free') source = replaceOne(source, 'return pricing !== null && pricing.input === 0 && pricing.output === 0;', 'return false;');
  if (name === 'missing-provider-guard') source = replaceOne(source, "if (typeof model !== 'string' || model.length === 0) return 'unknown';", '');
  writeFileSync(file, source);
  if (name === 'missing-source') rmSync(file);
  const testPath = 'packages/ai-gateway/src/test/eval-null-model-accounting.test.ts';
  writeFileSync(join(cwd, testPath), fixture);
  const result = spawnSync(process.execPath, ['test', testPath], { cwd, encoding: 'utf8', timeout: 15000, env: { PATH: dirname(process.execPath), CI: 'true' } });
  if (process.env.EVAL_CALIBRATION_RESULTS) {
    const out = resolve(process.env.EVAL_CALIBRATION_RESULTS); mkdirSync(out, { recursive: true });
    for (const ext of ['stdout', 'stderr']) writeFileSync(join(out, name + '.' + ext), result[ext] || '');
    writeFileSync(join(out, name + '.json'), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message || null }) + '\n');
  }
  return result;
}
function passes(r) { expect(r.error).toBeUndefined(); expect(r.status).toBe(0); expect(r.stderr).toContain('13 pass'); }
function fails(r, count) { expect(r.error).toBeUndefined(); expect(r.signal).toBeNull(); expect(r.status).toBe(1); expect(r.stderr).not.toContain('Cannot find module'); expect(r.stderr).toMatch(/expect\(received\)|TypeError: null is not an object|undefined is not an object/); expect(r.stderr).toContain(`${count} fail`); expect(r.stderr).toContain(`${13 - count} pass`); }
test('parent fails six missing-model outcomes and preserves seven', () => fails(grade('parent'), 6));
test('reference passes', () => passes(grade('reference')));
test('current source passes', () => passes(grade('current')));
test('manifest oracle path alone repairs the parent', () => passes(grade('oracle-only')));
test('unused correct source does not fix executed exports', () => fails(grade('unused'), 6));
test('equivalent guard is accepted', () => passes(grade('equivalent')));
test('unknown models marked free are rejected', () => fails(grade('free-unknown'), 5));
test('blanket fallback loses priced and free behavior', () => fails(grade('blanket-fallback'), 4));
test('removing free classification is rejected', () => fails(grade('lost-free'), 1));
test('price guard alone cannot repair provider inference', () => fails(grade('missing-provider-guard'), 2));
test('missing module remains a setup error', () => { const r = grade('missing-source'); expect(r.status).not.toBe(0); expect(r.stderr).toContain('Cannot find module'); expect(r.stderr).not.toContain('expect(received)'); });
