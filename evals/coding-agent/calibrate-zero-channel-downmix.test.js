// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { classifyGraderError } from './grader-outcome.mjs';
const repo = resolve(import.meta.dir, '../..');
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'))).cases.find(c => c.id === 'app-zero-channel-downmix');
const path = item.oracle_paths[0];
const git = ref => execFileSync('git', ['show', `${ref}:${path}`], { cwd: repo, encoding: 'utf8' });
const parent = git(item.base_ref), fixed = git(item.oracle_ref);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function change(from, to) { expect(fixed.split(from)).toHaveLength(2); return fixed.replace(from, to); }
test('calibrate zero-channel converter outcomes and preserved samples', () => {
  const controls = [
    ['parent', parent, 'fail'], ['reference', fixed, 'pass'],
    ['equivalent', change('channels.max(1)', '(if channels == 0 { 1 } else { channels })'), 'pass'],
    ['unused-correct', parent, 'fail'],
    ['blanket-empty', 'pub fn audio_to_mono(_: &[f32], _: u16) -> Vec<f32> { vec![] }', 'fail'],
    ['zero-discards', change('let channels = channels.max(1) as usize;', 'if channels == 0 { return vec![]; }\n    let channels = channels as usize;'), 'fail'],
    ['zero-empty-panics', change('let channels = channels.max(1) as usize;', 'if channels == 0 && audio.is_empty() { panic!("empty buffer"); }\n    let channels = channels.max(1) as usize;'), 'fail'],
    ['no-average', change('let mono_sample = sum / channels as f32;', 'let mono_sample = sum;'), 'fail'],
    ['drop-partial', change('audio.chunks(channels)', 'audio.chunks_exact(channels)'), 'fail'],
    ['partial-denominator', change('let mono_sample = sum / channels as f32;', 'let mono_sample = sum / chunk.len() as f32;'), 'fail'],
    ['rectify-samples', change('chunk.iter().sum()', 'chunk.iter().map(|sample| sample.abs()).sum()'), 'fail'],
    ['missing-source', null, 'error'],
  ];
  for (const [name, source, expected] of controls) {
    const root = mkdtempSync(join(tmpdir(), 'downmix-calibration-'));
    try {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      if (source !== null) writeFileSync(join(root, path), source);
      if (name === 'unused-correct') writeFileSync(join(root, 'unused-correct.rs'), fixed);
      const fixtureHashes = {};
      for (const fixture of item.grader.fixtures) {
        const bytes = readFileSync(join(import.meta.dir, fixture.local_path));
        const destination = join(root, fixture.destination_path);
        mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, bytes);
        fixtureHashes[fixture.local_path] = hash(bytes);
      }
      const result = spawnSync('/bin/bash', ['-c', item.grader.command], { cwd: root, encoding: 'utf8', timeout: item.grader.timeout_seconds * 1000, maxBuffer: 8 * 1024 * 1024 });
      const errorKind = classifyGraderError(result);
      const observed = result.error || result.signal || errorKind ? 'error' : result.status === 0 ? 'pass' : 'fail';
      if (process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS) {
        const dir = resolve(process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS); mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${name}.json`), JSON.stringify({ command: item.grader.command, expected, observed, status: result.status, signal: result.signal, error: result.error?.message ?? null, error_kind: errorKind, source_sha256: source === null ? null : hash(source), fixture_hashes: fixtureHashes, stdout: result.stdout, stderr: result.stderr }, null, 2));
      }
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(observed).toBe(expected);
      if (expected === 'pass') expect(result.stdout).toContain('10 passed; 0 failed');
      if (expected === 'fail') { expect(result.status).toBe(101); expect(result.stdout).toContain('test result: FAILED.'); }
      if (name === 'parent' || name === 'unused-correct') expect(result.stdout).toContain('8 passed; 2 failed');
      if (name === 'missing-source') expect(errorKind).toBe('rust_compile_error');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}, 240_000);
