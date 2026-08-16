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

- Mapped specs: 117
- Declared test blocks: 334
- Weighted coverage points: 261.3

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 89 | 288 | 235.3 | 15 | 93 | 92% |
| macos | 113 | 297 | 232.1 | 17 | 99 | 90% |
| linux | 79 | 248 | 206.0 | 14 | 89 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 323
- Active test blocks: 3136
- Ignored/manual test blocks: 137
- Weighted coverage points: 2578.1

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 3003 | 132 | 2517.3 | 21 | 11 | 100% |
| macos | 29 | 3058 | 112 | 2528.5 | 22 | 11 | 100% |
| linux | 25 | 2676 | 105 | 2221.1 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
