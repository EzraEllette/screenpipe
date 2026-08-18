# Fast native development builds

<!-- doc-covers: none -->

There are exactly two normal native-development commands. Run them from
`apps/screenpipe-app-tauri`:

```bash
# Live frontend + native app loop.
bun run dev:tauri

# One-shot native test binary, without packaging an installer or app bundle.
bun run build:tauri:dev
```

Both package scripts pass the named profile as Cargo runner arguments:
`-- --profile debug-dev`. The space-separated form matters. It makes Tauri
2.11.2 select `src-tauri/target/debug-dev`; `--debug` instead selects Cargo's
built-in `dev` profile.

Do not add `--no-sign`: the live command does not bundle, and the one-shot
command explicitly uses `--no-bundle`, so there is no signing step to skip. Do
not add `cargo clean`, a shared `CARGO_TARGET_DIR`, incremental/profile
environment overrides, or one-off compiler-cache settings. The checked-in
`debug-dev` profile is the single source of truth: no first-party debuginfo,
high parallel codegen, and no per-worktree incremental state.

For React/layout-only work, `bun run dev:web` is still faster because it avoids
Rust entirely.

## macOS permissions

Signing is separate from the normal build loop. Only create a signed `.app`
when the test specifically needs a stable macOS TCC identity across rebuilds:

```bash
apps/screenpipe-app-tauri/scripts/build_macos.sh
```

That script uses the same `debug-dev` profile, builds only the macOS app bundle,
and signs it with its configured development identity. Set
`APPLE_SIGNING_IDENTITY` to use a different stable certificate. Normal
development builds should not copy its packaging/signing steps; otherwise use
the two commands above.
