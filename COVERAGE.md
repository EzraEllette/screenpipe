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

- Mapped specs: 121
- Declared test blocks: 356
- Weighted coverage points: 280.2

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 92 | 304 | 248.6 | 15 | 100 | 92% |
| macos | 117 | 318 | 250.0 | 17 | 108 | 90% |
| linux | 81 | 262 | 218.0 | 14 | 97 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 331
- Active test blocks: 3223
- Ignored/manual test blocks: 137
- Weighted coverage points: 2642.5

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 3084 | 132 | 2579.1 | 21 | 11 | 100% |
| macos | 29 | 3142 | 112 | 2591.5 | 22 | 11 | 100% |
| linux | 25 | 2758 | 105 | 2282.4 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
