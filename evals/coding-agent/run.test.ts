// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("process failures cannot prove a regression or count as scored failures", () => {
  const repo = mkdtempSync(join(tmpdir(), "eval-runner-control-"));
  const runner = new URL("./run.mjs", import.meta.url).pathname;
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 10_000 });
    if (result.status !== 0) throw new Error(result.stderr || String(result.error));
    return result.stdout.trim();
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Synthetic eval control");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "state.txt"), "broken");
    git("add", "state.txt");
    git("commit", "-qm", "Synthetic broken state");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "state.txt"), "fixed");
    git("commit", "-qam", "Synthetic reference state");
    const fix = git("rev-parse", "HEAD");
    const controls = [
      { id: "baseline-timeout", baseline: "error", oracle: "pass", valid: false },
      { id: "intended-failure", baseline: "fail", oracle: "pass", valid: true },
      { id: "both-pass", baseline: "pass", oracle: "pass", valid: false },
      { id: "reference-timeout", baseline: "pass", oracle: "error", valid: false },
      { id: "baseline-signal", baseline: "error", oracle: "pass", valid: false },
      { id: "reference-signal", baseline: "pass", oracle: "error", valid: false },
    ];
    writeFileSync(join(repo, "grade.mjs"), `
import { readFileSync } from "node:fs";
const broken = readFileSync("state.txt", "utf8") === "broken";
const id = process.env.SCREENPIPE_EVAL_CASE_ID;
const affected = id.startsWith("baseline-") ? broken : !broken;
if (id.endsWith("-timeout") && affected) setInterval(() => {}, 1000);
else if (id.endsWith("-signal") && affected) process.kill(process.pid, "SIGTERM");
else process.exit(id === "intended-failure" && broken ? 1 : 0);
`);
    const manifest = join(repo, "cases.json");
    writeFileSync(manifest, JSON.stringify({
      schema_version: 1, suite: "synthetic-runner-controls", dataset_version: "1",
      cases: controls.map(({ id }) => ({
        id, name: id, base_ref: base, oracle_ref: fix, oracle_paths: ["state.txt"],
        source: { kind: "git_regression", fix_commit: fix },
        prompt: "Synthetic harness control; no model is invoked.",
        grader: { timeout_seconds: 1, command: "exec node grade.mjs",
          fixtures: [{ local_path: "grade.mjs", destination_path: "grade.mjs" }] },
      })),
    }));
    const invoke = (directory: string, ...args: string[]) => spawnSync("node", [
      runner, "--repo", repo, "--manifest", manifest, "--results-dir", join(repo, directory), ...args,
    ], { cwd: repo, encoding: "utf8", timeout: 60_000 });
    const verified = invoke("verification", "--verify");
    expect(verified.error).toBeUndefined();
    expect(verified.status).toBe(1); // Invalid controls must make the CLI reject verification.
    const results = JSON.parse(readFileSync(join(repo, "verification/verification.json"), "utf8"));
    expect(results).toHaveLength(controls.length);
    for (const control of controls) {
      const result = results.find((item: { case_id: string }) => item.case_id === control.id);
      expect(result.baseline.harness_error).toBeUndefined();
      expect(result.oracle.harness_error).toBeUndefined();
      expect(result.baseline.outcome).toBe(control.baseline);
      expect(result.oracle.outcome).toBe(control.oracle);
      expect(result.valid).toBe(control.valid);
      const errored = control.baseline === "error" ? result.baseline :
        control.oracle === "error" ? result.oracle : null;
      if (errored) {
        expect(errored.passed).toBe(false);
        expect(errored.grader_exit).toBeNull();
        expect(errored.grader_signal).toBe("SIGTERM");
        if (control.id.endsWith("timeout")) expect(errored.grader_error).toContain("ETIMEDOUT");
      }
    }
    const scored = invoke("scoring", "--mode", "baseline", "--case", "baseline-signal");
    expect(scored.error).toBeUndefined();
    expect(scored.status).toBe(0);
    const summary = JSON.parse(readFileSync(join(repo, "scoring/summary.json"), "utf8"));
    expect(summary.cases[0]).toMatchObject({ errors: 1, scored_trials: 0, success_rate: null });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}, 90_000);
