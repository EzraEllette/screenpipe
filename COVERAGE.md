# Screenpipe Coverage

Screenpipe tracks coverage at two complementary layers:

- Tauri/WebDriver E2E coverage: real product UX and local API behavior by platform.
- Core engine coverage: Rust behavioral flow coverage across capture, audio, DB, accessibility, and engine crates.

These dashboards are behavioral maps, not a replacement for line or branch coverage.
Use them to see which product risks are represented, then layer runtime job
results and `cargo llvm-cov` data on top when judging release confidence.

## Dashboards

- E2E dashboard: [apps/screenpipe-app-tauri/e2e/COVERAGE.md](apps/screenpipe-app-tauri/e2e/COVERAGE.md)
- Core engine dashboard: [coverage/CORE.md](coverage/CORE.md)

## Current Snapshot

### Tauri E2E

- Mapped specs: 40
- Declared test blocks: 142
- Weighted coverage points: 113.2

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 33 | 131 | 109.8 | 14 | 39 | 92% |
| macos | 37 | 112 | 87.4 | 14 | 40 | 89% |
| linux | 28 | 100 | 83.9 | 12 | 36 | 86% |

### Core Engine

- Mapped suites: 23
- Mapped Rust files: 190
- Active test blocks: 1640
- Ignored/manual test blocks: 108
- Weighted coverage points: 1366.1

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 20 | 1543 | 105 | 1320.3 | 21 | 11 | 100% |
| macos | 20 | 1595 | 85 | 1338.4 | 22 | 11 | 100% |
| linux | 18 | 1532 | 82 | 1309.7 | 20 | 11 | 95% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
