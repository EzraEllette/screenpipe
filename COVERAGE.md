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

- Mapped specs: 101
- Declared test blocks: 285
- Weighted coverage points: 219.9

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 79 | 247 | 199.4 | 15 | 88 | 91% |
| macos | 97 | 248 | 190.7 | 17 | 90 | 90% |
| linux | 69 | 207 | 169.2 | 14 | 83 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 316
- Active test blocks: 2965
- Ignored/manual test blocks: 137
- Weighted coverage points: 2439.5

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 2834 | 132 | 2379.5 | 21 | 11 | 100% |
| macos | 29 | 2888 | 112 | 2390.6 | 22 | 11 | 100% |
| linux | 25 | 2523 | 105 | 2098.4 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
