---
name: pull request
about: submit changes to the project
title: "[pr] "
labels: ''
assignees: ''

---

## description

brief description of the changes in this pr.

related issue: #

> attach screenshots / recordings here — **never commit media into the repo.** agents/cli: `gh release upload <tag> file.png` (or `gh gist create file.png`) and paste the url. humans: just drag the file into this box — github hosts it.

## before

a screen recording of the app/cli before this change

## after

a screen recording of the app/cli after this change

## how to test

add a few steps to test the pr in the most time efficient way.

1. 
2. 
3. 

## desktop app checklist (if applicable)

If this PR adds or changes `#[tauri::command]` handlers or Rust types exported to the frontend, from `apps/screenpipe-app-tauri/`:

- [ ] `bun run bindings:generate` (if bindings changed)
- [ ] `bun run bindings:check`
- [ ] `bun run typecheck`

Commands are auto-collected via the vendored `tauri-helper` crate — no manual handler list edits in `main.rs`.

