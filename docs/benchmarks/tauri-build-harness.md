# Safe Tauri build timing and disk-attribution harness

Date: 2026-07-24

Implementation task: `t_09a4c44d`

Verification/documentation task: `t_aad016ad`

Benchmark contract: `reports/01-benchmark-contract.md`

## Status

The harness is implemented at:

`apps/screenpipe-app-tauri/scripts/benchmark_tauri_build.py`

Its Linux-fast unit tests are at:

`apps/screenpipe-app-tauri/scripts/benchmark_tauri_build_test.py`

This task implemented and smoke-tested the harness. It did **not** run an authoritative macOS build benchmark and makes no claim that the under-three-minute or disk-use targets have been met.

## Safety model

The harness does not invoke `cargo clean` and does not alter a caller's existing target directory. Every run receives:

- a detached Git worktree pinned to the resolved commit;
- a run-local `CARGO_TARGET_DIR`;
- a scenario-scoped cache root;
- a run-local temporary directory;
- an immutable run manifest before build commands start.

H0 gets a new empty cache root for every run and forcibly disables both `RUSTC_WRAPPER` and Cargo incremental compilation. F1, W1, and P1 reuse only the cache root belonging to the named benchmark output/scenario. Baseline and candidate never share compiled targets.

The output volume must have 250 GiB free by default. This is a preflight floor, not a predicted build size and not evidence for the previously reported `>200 GB`. Override it only deliberately with `--minimum-free-gib`.

A non-empty output directory is accepted only if it contains the harness marker `benchmark-root.json`. Existing run IDs are never overwritten. A failed worktree checkout is removed only when it is the new harness-owned path. Successful worktrees and raw evidence are retained for inspection; the harness does not automatically delete them.

Relevant environment values and commands are redacted before persistence. Names containing token, secret, password, private, credential, cookie, auth, signing, key, or database URL indicators are replaced with `<redacted>`. URL user information plus credential-like query/fragment fields are redacted. Compound command options such as `--api-key`, `--private-key`, and `--key-path` redact both inline and following values. Do not pass secrets in unrecognized positional syntax.

Every executed run also requires a JSON verification plan. For H0, F1, and W1 it must contain exactly `isolated_launch` and `production_data_untouched`; P1 additionally requires `platform_signature` and `updater_artifacts`. Each value is a non-empty command argument array. Before each verifier starts, the harness resolves and hashes its executable and hashes every command argument that names a file, including inputs outside the worktree and benchmark roots. Persisted paths are root-relative labels or `<external-file>`; external paths echoed by a verifier are redacted, and file contents are never retained as provenance. The harness then executes the command with a fixed timeout after a successful build and retains the redacted command, exit status, stdout, stderr, and pre-execution provenance in `artifacts/verification.json`. Boolean assertions supplied by a caller are not accepted as evidence. Verifiers run from the app worktree with `CARGO_TARGET_DIR`, `SCREENPIPE_BENCHMARK_RUN_ROOT`, and an isolated `SCREENPIPE_BENCHMARK_DATA_DIR` in their environment. A verifier must perform the named check and exit nonzero on any mismatch; a placeholder such as `true` is not valid evidence.

Sidecar and identity gates do not rely on caller assertions. The harness derives required sidecars from the merged effective Tauri configuration and checks matching target-architecture files in ordinary bundle trees. For AppImage, NSIS, and MSI outputs it extracts the package with `7z`/`7zz`, inventories the extracted files, and fails the sidecar gate when inspection is unavailable or incomplete. It derives the expected developer or production identifier/product name from the scenario and checks the merged configuration. P1 additionally binds the verifier-observed identity and signature result to one exact inventoried bundle path and SHA-256; `.app` directory bundles use a deterministic relative-path-and-file-content tree hash. It also requires `out/index.html` and recomputes the current frontend input hash through the exported build-script function; `.frontend-build-key` must equal that recomputed value, not merely exist.

## Prerequisites

Run from a Screenpipe checkout with:

- Python 3.11 or newer;
- Git;
- Bun and the project-pinned Tauri CLI dependencies;
- Rust/Cargo and platform build prerequisites;
- enough free space on the selected output volume;
- on macOS, the SDK/toolchain required by the selected target;
- for P1, the exact production environment and signing/notarization prerequisites;
- `7z` or `7zz` when P1 produces AppImage, NSIS, or MSI packages whose sidecars must be inspected.

Refresh `origin/main` yourself before the benchmark if network policy permits. The harness performs no fetch and resolves only local revisions. Record and verify the resulting SHA.

## Fast verification

From the repository root:

```sh
python3 -m py_compile \
  apps/screenpipe-app-tauri/scripts/benchmark_tauri_build.py \
  apps/screenpipe-app-tauri/scripts/benchmark_tauri_build_test.py
python3 -m unittest apps/screenpipe-app-tauri/scripts/benchmark_tauri_build_test.py
```

These are the authoritative Linux-fast checks. They require neither Bun nor a Tauri build and cover isolated scenario paths, command construction, failure status, summary/distribution parsing, disk attribution, unavailable RSS, redaction, and pinned baseline/candidate metadata. The isolation test creates sentinel files in simulated developer `CARGO_TARGET_DIR` and `CARGO_HOME` directories and proves that hermetic setup neither reuses nor removes them.

A no-build smoke run creates a real detached worktree and all pre-build metadata without running Bun install or Tauri:

```sh
apps/screenpipe-app-tauri/scripts/benchmark_tauri_build.py \
  --output /Volumes/BuildBench/screenpipe-smoke \
  --scenario F1 \
  --dry-run \
  run --variant candidate --revision HEAD
```

Use a benchmark output volume, not a small tmpfs. The default 250 GiB preflight intentionally rejects undersized `/tmp` mounts.

## Baseline/candidate comparison

All global options precede the `run` or `compare` subcommand.

Recommended F1 comparison:

```sh
HARNESS=apps/screenpipe-app-tauri/scripts/benchmark_tauri_build.py
OUTPUT=/Volumes/BuildBench/screenpipe-f1-$(date -u +%Y%m%dT%H%M%SZ)
VERIFY=/secure/build-verifiers/developer-verification-plan.json

"$HARNESS" \
  --repo "$PWD" \
  --output "$OUTPUT" \
  --scenario F1 \
  --verification-plan "$VERIFY" \
  compare \
  --baseline origin/main \
  --candidate HEAD \
  --runs 3
```

For reusable-cache scenarios, `compare` first runs unmeasured baseline and candidate conditioning builds as repetition `00`. This avoids giving the candidate a cache populated only by the first measured baseline run. Conditioning results remain in the evidence tree but are excluded from `summary.csv`. Use `--skip-conditioning` only when the same output's scenario cache was deliberately prepared for both revisions already.

Example plan shape for H0, F1, and W1 (use reviewed platform-specific verifier programs, not these placeholder paths):

```json
{
  "isolated_launch": ["/secure/build-verifiers/verify-isolated-launch"],
  "production_data_untouched": ["/secure/build-verifiers/verify-production-data-untouched"]
}
```

Each verifier must print exactly one JSON object to stdout. Every object includes `gate`, the built `artifact_sha256`, and a `checks` object with the named checks set to `true`. `isolated_launch` additionally reports the exact `benchmark_data_dir` from the harness environment, a non-empty `readiness` condition, positive `timeout_seconds`, and the isolated port; its checks are `artifact_launched`, `isolated_data_dir`, and `readiness_reached`. `production_data_untouched` reports an absolute production data directory, the production port, and identical 64-character `before_state_sha256` / `after_state_sha256`; its checks are `production_data_unchanged` and `production_port_untouched`. The harness rejects equal isolated/production ports. P1 `platform_signature` reports `signature_valid`, non-empty `verification_output`, the bundle-observed `screenpi.pe` / `screenpipe` identity, and the exact absolute `artifact_path` plus `artifact_sha256` of one inventoried production bundle. P1 `updater_artifacts` reports `updater_artifact_exists`, `updater_signature_valid`, and exact absolute `updater_path` / `signature_path` plus their SHA-256 values. The two updater paths and hashes must be distinct and must resolve uniquely to inventory entries with the expected updater/package-signature roles. Empty output, malformed JSON, ambiguous or same-artifact evidence, unbound paths or hashes, or incomplete checks fail closed even when the command exits zero.

Measured repetitions alternate order:

`B1, C1, C2, B2, B3, C3`

No target directory is shared. The same scenario download/native/frontend cache is shared after conditioning. Failed runs are retained and stop the comparison.

Before interpreting the comparison, record `git rev-parse origin/main` and `git rev-parse HEAD`. The harness resolves both revisions to commits before the first run, rejects any baseline that does not equal the locally pinned `origin/main`, and rechecks that `origin/main` still resolves to the same commit before and after every conditioning or measured run. Use a new output directory for each comparison; run IDs are intentionally non-overwritable.

## Scenarios

### H0 — hermetic zero-cache cold

```sh
"$HARNESS" \
  --output /Volumes/BuildBench/screenpipe-h0 \
  --scenario H0 \
  --verification-plan "$VERIFY" \
  compare --baseline origin/main --candidate HEAD --runs 3
```

Each run has empty Cargo, Bun, native, and frontend caches. The command is:

`bun tauri build --debug --no-bundle --no-sign -- --locked --timings`

H0 refuses `--enable-sccache`. OS filesystem caches are not purged.

### F1 — fresh worktree with reusable scenario caches

F1 starts each measured repetition with a new worktree, no local `node_modules`, no frontend output, and a unique target. Scenario Cargo/Bun/native/frontend caches are retained after the two conditioning runs. Compiler caching remains disabled unless explicitly enabled.

### W1 — warm incremental no-op

```sh
"$HARNESS" \
  --output /Volumes/BuildBench/screenpipe-w1 \
  --scenario W1 \
  --verification-plan "$VERIFY" \
  compare --baseline origin/main --candidate HEAD --runs 3
```

For each repetition, the harness materializes dependencies, runs an unmeasured `15-warmup` build in that run's target, and then measures the identical command as `20-tauri-build`. The warmup is retained in timing JSONL. `summary.csv` reports dependency materialization as `install_ms`, the measured no-op build as `incremental_ms`, and uses only that incremental interval for W1 `total_ms`; install and warmup are not folded into the edit/build-loop total.

This implements W1a, the no-op incremental case. Fixed Rust-leaf and frontend-leaf mutations (W1b/W1c) are not automated; if used, they must be identical, content-changing, hash-recorded patches on both revisions and reverted after measurement as specified in the benchmark contract.

### P1 — production release

P1 refuses to run without a quoted exact `--command`; this prevents a local unsigned release from being mislabeled as production. Supply the exact workflow-equivalent signed command and export the workflow's target/features/profile environment before invocation. Example command shape only:

```sh
"$HARNESS" \
  --output /Volumes/BuildBench/screenpipe-p1 \
  --scenario P1 \
  --command 'bun tauri build --config src-tauri/tauri.prod.conf.json -- --locked --timings --target aarch64-apple-darwin' \
  --verification-plan /secure/build-verifiers/p1-verification-plan.json \
  compare --baseline origin/main --candidate HEAD --runs 3
```

The example is not a certification that all current release-workflow features or post-build notarization steps are represented. Compare it with the pinned `.github/workflows/release-app.yml`, use the exact command/environment for the named platform, and time notarization separately. Do not call a no-sign diagnostic build P1.

P1 fails closed unless the artifact is under the command-selected profile directory, signature evidence identifies exactly one hashed bundle below that profile's `bundle/` tree, its recorded architecture matches the command-selected target, merged configuration and bundle-bound verifier output identify `screenpi.pe` / `screenpipe`, required sidecars exist for the target architecture in the bundle tree or a completely inspected AppImage/NSIS/MSI package, and all four harness-executed verification commands exit zero. The P1 plan must contain exactly `isolated_launch`, `production_data_untouched`, `platform_signature`, and `updater_artifacts`. Missing, extra, malformed, skipped, ambiguous, or failed commands make `success` false or reject the run. A debug executable, unbundled or unsigned release, or artifact from the wrong architecture/profile cannot pass P1.

### Optional sccache measurement

Add `--enable-sccache` to F1, W1, or P1. The harness sets a scenario-local `SCCACHE_DIR`, captures raw JSON stats before and after every run, computes hit/miss deltas, and records the hit rate when counters are available. Use identical settings for baseline and candidate.

## Additional Cargo arguments

Repeat `--release-arg` before the subcommand to append exact Cargo passthrough arguments after `--locked --timings`:

```sh
"$HARNESS" \
  --output /Volumes/BuildBench/screenpipe-f1-arm64 \
  --scenario F1 \
  --verification-plan "$VERIFY" \
  --release-arg=--target \
  --release-arg=aarch64-apple-darwin \
  compare --baseline origin/main --candidate HEAD --runs 3
```

For P1, prefer the exact quoted `--command` rather than reconstructing workflow semantics from individual arguments.

## Evidence layout

Each run lives under `OUTPUT/runs/<run-id>/`:

- `manifest.json`: scenario, variant, pinned commit, expected profile, redacted effective environment, commands, machine identity hash, and isolated paths;
- `result.json`: manifest plus stage results and success state;
- `artifacts/timings.jsonl`: one schema-1 JSON object per measured command stage;
- `artifacts/logs/*.log`: merged stdout/stderr with monotonic timestamp and stage prefix on every line;
- `artifacts/samples/*.jsonl`: one-second process-tree RSS and filesystem-free-space samples, with target allocation sampled every five seconds;
- `artifacts/cargo-timings/`: copied Cargo `--timings` HTML and related files;
- `artifacts/frontend-cache-validation.json`: retained marker, recomputed current frontend-input hash, comparison result, and redacted hash-command output;
- `artifacts/sccache.json`: before/after stats, hit/miss deltas, and hit rate;
- `artifacts/verification.json`: harness-executed runtime/data/signature/updater commands with redacted output, exit status, and complete pre-execution verifier/input hashes;
- `artifacts/effective-config.json`: command-selected Cargo profile, merge-order config chain, merged redacted Tauri configuration, all discovered config inputs, and lock/config hashes;
- `artifacts/storage-before.json` and `storage-after.json`: apparent and allocated totals, largest files, and largest subtrees for worktree, target, whole Cargo home plus its registry/git subtrees, Bun, native, frontend-cache, sccache, and temp roots;
- `artifacts/target-attribution.json`: profile totals, `build`, `deps`, `incremental`, `bundle`, debug-symbol totals, architecture-attributed files, and duplicate artifact names spanning profiles;
- `artifacts/artifacts.json`: only expected target-profile executables and files below target bundle outputs, deterministic `.app` tree hashes, bundle-file hashes, AppImage/NSIS/MSI inspection status and extracted-file inventory, plus top-level sidecar inventory; executable-bit source files are excluded;
- `artifacts/source-before.json` and `source-after.json`: expected/head SHA and Git status checks.

`OUTPUT/summary.csv` contains all measured, non-dry runs, including failures with their elapsed time and exit status. Dry-run result manifests are explicitly marked `measured: false`. Failed runs never feed `summary-stats.json`, candidate deltas, or human-readable medians; `summary.txt` reports how many were excluded. The CSV includes the contract stage columns (`install`, `prebuild`, `frontend`, `cargo`, `link`, `bundle`, `sign`, and `notarize`), plus whole-build/warmup/incremental fields, total wall time, peak sampled RSS, peak filesystem consumption, and the first nonzero exit status (including negative signal exits). Unsupported decomposed stages remain blank rather than being invented from the enclosing Tauri stage. `OUTPUT/summary-stats.json` reports count, median, min, max, and median absolute deviation for each available successful timing field and absolute/percentage candidate change from the same-scenario baseline median. Keep JSONL and raw logs as the source of truth.

### Schema guide

All JSON objects currently use `schema: 1`. Important stable fields are:

- `manifest.json`: `run_id`, `scenario`, `variant`, `revision`, resolved `commit`, command-derived `expected_profile`, `machine`, redacted `environment`, isolated `paths`, redacted build and verification commands, `dry_run`, `measured`, `expected_architecture`, and `measurement_availability`;
- `result.json`: every manifest field plus `stages`, `cargo_timing_files`, `correctness`, `success`, and `completed_utc` for executed runs;
- each `artifacts/timings.jsonl` record: `run_id`, `scenario`, `variant`, `commit`, `machine_id`, `stage`, redacted `command`, UTC bounds, `elapsed_ms`, nullable resource counters, `max_rss_bytes`, `peak_target_bytes`, `peak_disk_bytes`, `exit_code`, and explanatory `notes`;
- `summary.csv`: one row per measured run with identity fields, `total_ms`, bounded stage columns, `warmup_ms`, `build_ms`, `incremental_ms`, nullable `peak_rss_bytes`, `peak_disk_bytes`, and aggregate `exit_code`;
- `summary-stats.json`: successful-run-only `groups[scenario][variant][metric]` distributions and `comparisons[scenario][metric]` baseline/candidate median deltas;
- `summary.txt`: concise human-readable medians, ranges, MAD, commit identity, and correctness-verification counts.

Missing or unsupported numeric measurements are JSON `null` (or blank CSV cells), never fabricated zeroes. A real observed zero remains numeric zero.

## Authoritative macOS benchmark procedure

1. Use one physical macOS machine for the complete baseline/candidate block. Keep power mode, thermal conditions, free-space volume, Xcode/SDK, Rust, Bun, Node, linker, network policy, and signing environment unchanged.
2. Refresh the local remote-tracking reference if authorized, then record `git rev-parse origin/main`. Do not fetch or move `origin/main` after starting the block.
3. Check out the candidate task branch, confirm a clean worktree, choose a fresh output directory on a volume with at least the configured free-space floor, and run the Linux-fast verification commands above.
4. Run F1 first with at least three interleaved measured repetitions using the exact comparison command above. Do not use `--skip-conditioning` on a fresh output root.
5. Run H0 and W1 into separate fresh output roots when those scenarios are required. Label W1 results as W1a no-op; do not infer W1b/W1c edit-loop behavior from them.
6. Run P1 only from the controlled signing-capable environment with the exact production workflow command and a reviewed verification-command plan. Verify the retained command output and executable/input hashes for isolated launch/runtime data, signature/notarization, and updater artifacts; inspect the harness-derived bundle identity, sidecars, profile, and architecture checks.
7. Confirm every measured `result.json` has `success: true`, inspect failed records rather than deleting them, and retain raw logs, Cargo timing HTML, manifests, configuration hashes, and storage attribution.
8. Compare medians and MAD in `summary-stats.json`; inspect stage logs and Cargo timing reports before attributing a change. Archive the full output roots with the two pinned SHAs and machine/toolchain metadata.

## Timing and storage interpretation

Top-level bounded stages are `10-install` and `20-tauri-build`; W1 also has excluded warmup stage `15-warmup`. Cargo's HTML timing report supplies crate/build-script critical-path detail inside the Tauri stage. The harness does not pretend parallel crate-duration sums are wall time.

The process-tree sampler uses `/proc` on Linux and `ps` on macOS-like systems. When process enumeration is available, peak RSS is the sampled sum of the root process and descendants. If enumeration fails or the stage root process vanishes before the first sample, `max_rss_bytes` is `null` and the stage notes explicitly mark peak RSS unsupported; a missed process is never reported as measured zero RSS. Every stage uses the same run-level free-space baseline captured before install, so peak filesystem consumption is cumulative across install, warmup, and build rather than reset at each stage. Directory reports include both apparent bytes and allocated bytes. On APFS, filesystem free-space change remains the physical-volume authority because clones, compression, sparse files, and hard links make directory sums non-additive.

The current portable sampler does not have uncontaminated per-process CPU, disk-I/O, or network byte counters. Those timing JSONL fields are therefore `null` with explicit unsupported notes, not misleading observed zeroes. Peak RSS remains measured when host process enumeration is available; target growth, filesystem free-space samples, wall time, and exit status remain measured on supported benchmark hosts.

## Claim gate

Do not claim the performance target from a dry run, a failed run, one revision, mismatched cache states, or a Linux smoke test. In particular, the under-three-minute objective cannot be claimed without same-machine measurements against unchanged `origin/main`. A valid claim needs unchanged pinned `origin/main` and candidate measurements on the same physical machine, identical named scenario, interleaved repetitions, successful expected artifacts, and all correctness checks from `01-benchmark-contract.md`.

The harness captures source cleanliness, command exit, expected profile artifacts, architecture, frontend output, sidecars, config, and retained evidence. P1 additionally requires explicit production identity, sidecar, isolated launch/runtime-data, platform signature, and updater verification evidence before it can report success. A timing is not publishable until every applicable gate is verified.
