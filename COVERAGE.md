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

- Mapped specs: 124
- Declared test blocks: 362
- Weighted coverage points: 285.0

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 94 | 307 | 251.3 | 15 | 102 | 92% |
| macos | 120 | 324 | 254.8 | 17 | 111 | 90% |
| linux | 83 | 265 | 220.7 | 14 | 99 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 336
- Active test blocks: 3264
- Ignored/manual test blocks: 137
- Weighted coverage points: 2672.7

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 3125 | 132 | 2609.3 | 21 | 11 | 100% |
| macos | 29 | 3183 | 112 | 2621.7 | 22 | 11 | 100% |
| linux | 25 | 2797 | 105 | 2310.6 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
