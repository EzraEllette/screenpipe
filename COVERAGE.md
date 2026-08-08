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

- Mapped specs: 104
- Declared test blocks: 299
- Weighted coverage points: 233.3

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 81 | 260 | 212.4 | 15 | 89 | 91% |
| macos | 100 | 262 | 204.1 | 17 | 91 | 90% |
| linux | 71 | 220 | 182.2 | 14 | 84 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 316
- Active test blocks: 2970
- Ignored/manual test blocks: 137
- Weighted coverage points: 2443.0

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 2839 | 132 | 2383.0 | 21 | 11 | 100% |
| macos | 29 | 2893 | 112 | 2394.1 | 22 | 11 | 100% |
| linux | 25 | 2528 | 105 | 2101.9 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
