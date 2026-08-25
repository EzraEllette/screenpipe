# Screenpipe Coverage

Screenpipe tracks coverage at two complementary layers:

- Tauri/WebDriver E2E coverage: real product UX and local API behavior by platform.
- Core engine coverage: Rust behavioral flow coverage across capture, audio, DB, accessibility, and engine crates.

These dashboards are behavioral maps, not a replacement for line or branch coverage.
Use them to see which product risks are represented, then layer runtime job
results and `cargo llvm-cov` data on top when judging release confidence.

## Dashboards

- E2E dashboard: [apps/screenpipe-app-tauri/e2e/COVERAGE.md](apps/screenpipe-app-tauri/e2e/COVERAGE.md)
- Core engine dashboard: [docs/coverage/CORE.md](docs/coverage/CORE.md)

## Current Snapshot

### Tauri E2E

- Mapped specs: 122
- Declared test blocks: 358
- Weighted coverage points: 281.9

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 93 | 306 | 250.3 | 15 | 102 | 92% |
| macos | 118 | 320 | 251.7 | 17 | 110 | 90% |
| linux | 82 | 264 | 219.7 | 14 | 99 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 332
- Active test blocks: 3242
- Ignored/manual test blocks: 137
- Weighted coverage points: 2656.7

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 3103 | 132 | 2593.3 | 21 | 11 | 100% |
| macos | 29 | 3161 | 112 | 2605.7 | 22 | 11 | 100% |
| linux | 25 | 2777 | 105 | 2296.6 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
