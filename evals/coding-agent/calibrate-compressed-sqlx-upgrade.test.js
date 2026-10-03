// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { classifyGraderError } from './grader-outcome.mjs';
const repo = resolve(import.meta.dir, '../..');
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'))).cases.find(c => c.id === 'app-compressed-pending-sqlx-upgrades');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const setup = item.oracle_paths[0], schema = item.oracle_paths[1], readSchema = item.oracle_paths[2];
const files = ref => Object.fromEntries(item.oracle_paths.map(path => [path, git('show', `${ref}:${path}`)]));
const parent = files(item.base_ref), fixed = files(item.oracle_ref);
const fixture = readFileSync(join(import.meta.dir, 'graders/compressed-sqlx-upgrade.rs'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function change(source, path, from, to) {
  expect(source[path].split(from)).toHaveLength(2);
  return { ...source, [path]: source[path].replace(from, to) };
}
test('calibrate compressed upgrade outcomes with preservation and bypass controls', () => {
  const root = mkdtempSync(join(tmpdir(), 'compressed-upgrade-calibration-'));
  try {
    const archive = execFileSync('git', ['archive', item.base_ref, 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo', 'crates', 'LICENSE.md'], { cwd: repo, maxBuffer: 128 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', root], { input: archive });
    writeFileSync(join(root, 'crates/screenpipe-db/tests/eval_compressed_sqlx_upgrade.rs'), fixture);
    const controls = [
      ['parent', parent, 'fail'],
      ['reference', fixed, 'pass'],
      ['equivalent', change(fixed, setup, 'if !bootstrap_storage {', 'if bootstrap_storage == false {'), 'pass'],
      ['unused', parent, 'fail'],
      ['skip-migrations', change(fixed, setup, 'Self::sqlx_migrator().run(&db_manager.write_pool).await?;', '// Synthetic bypass: skip pending migrations.'), 'fail'],
      ['lose-existing-stars', change(fixed, setup, 'if !bootstrap_storage {', 'if !bootstrap_storage {\n                    sqlx::query("DELETE FROM starred_sessions").execute(&mut *conn).await?;'), 'fail'],
      ['skip-privacy-hooks', change(change(fixed, schema, 'super::read_schema::install_resident_hooks(&mut tx, &table).await?;', '// Synthetic bypass: no resident privacy repair.'), readSchema, 'install_resident_hooks(&mut tx, &table).await?;', '// Synthetic bypass: no initial resident privacy hooks.'), 'fail'],
      ['missing', { ...fixed, [readSchema]: null }, 'error'],
    ];
    for (const [name, source, expected] of controls) {
      for (const [path, body] of Object.entries(source)) {
        if (body === null) rmSync(join(root, path)); else writeFileSync(join(root, path), body);
      }
      const unused = join(root, 'unused-correct.rs');
      if (name === 'unused') writeFileSync(unused, fixed[setup]); else rmSync(unused, { force: true });
      // Calibration alone reuses its local target. Each test owns independent
      // temporary databases. This is not an evaluated agent workspace.
      const result = spawnSync('/bin/bash', ['-c', item.grader.command], { cwd: root, encoding: 'utf8', timeout: item.grader.timeout_seconds * 1000, maxBuffer: 8 * 1024 * 1024 });
      const errorKind = classifyGraderError(result);
      const observed = result.error || result.signal || errorKind ? 'error' : result.status === 0 ? 'pass' : 'fail';
      if (process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS) {
        const dir = resolve(process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS); mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${name}.json`), JSON.stringify({ command: item.grader.command, expected, observed, status: result.status, signal: result.signal, error: result.error?.message ?? null, error_kind: errorKind, source_hashes: Object.fromEntries(Object.entries(source).map(([path, body]) => [path, body === null ? null : hash(body)])), fixture_sha256: hash(fixture), stdout: result.stdout, stderr: result.stderr }, null, 2));
      }
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(observed).toBe(expected);
      if (expected === 'pass') expect(result.stdout).toContain('6 passed; 0 failed');
      if (expected === 'fail') { expect(result.status).toBe(101); expect(result.stdout).toContain('test result: FAILED.'); }
      if (name === 'parent') expect(result.stdout).toContain('2 passed; 4 failed');
      if (name === 'lose-existing-stars') expect(result.stdout).toContain('starred_upgrade_preserves_existing_sessions_and_tracks_mutations ... FAILED');
      if (name === 'skip-privacy-hooks') expect(result.stdout).toContain('later_resident_tables_receive_storage_and_privacy_hooks ... FAILED');
      if (name === 'missing') expect(errorKind).toBe('rust_compile_error');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 1_500_000);
