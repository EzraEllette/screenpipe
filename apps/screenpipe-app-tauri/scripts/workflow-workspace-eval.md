# Workflow workspace evaluation

The four agents use the normal Pi harness, Screenpipe API skill and scoped Pipe permissions. `workflow_workspace` handles durable drafts, handoffs and publication receipts. It does not choose recording queries or classify workflows.

## Model trials

From `apps/screenpipe-app-tauri`, with the local Screenpipe Pi runtime and an authenticated AI account installed:

```sh
bun scripts/eval-workflow-workspace.ts --large-context --conflict
bun scripts/eval-workflow-workspace.ts --ai-mediated --conflict
bun scripts/eval-workflow-workspace.ts --feedback-only
WORKFLOW_EVAL_MODEL=glm-5 bun scripts/eval-workflow-workspace.ts --no-change
```

These trials use real model calls and consume account usage. Recording data and persistence are fictional and isolated on a temporary loopback server. They do not modify the user's catalog. The script stops the child after 180 seconds and writes private trajectory/result artifacts to a temporary directory.

The withheld outcome checks distinguish directly observed actions from assistant completion claims and menu labels, accept work actually performed inside a chat, preserve source identity, exercise stale-write recovery, and check greetings are not treated as corrections. A successful process exit alone is not a pass. Private trials also check verified confidential transport.

These are sampled agent trials, not exhaustive quality guarantees. The mock persistence server does not substitute for native route/storage tests. A short Private trial passing does not establish reliability for a long real-history scan.

## Native validation

Use a signed dev app with the installed templates verified against source. Never rebuild its bundle during an active trial. Keep a private catalog/settings backup and retain failed-run evidence.

1. Start an update through the actual Workflows UI. Verify the intended model and execution IDs.
2. Observe Discover and Maintain running independently, durable draft handoffs to Deepen/Review, and atomic publication receipts.
3. Verify new/updated counts against persisted records and source quotations against original recording records, including actor and outcome semantics. An unchanged count can be correct; it must have an evidence-backed explanation.
4. Check the whole-cycle cursor advances only after completion. Stop/resume and stale writes must preserve catalog entries and human corrections.
5. Inspect generated steps and screenshot references in the native UI, and check capture health. Restore the user's model preference after model-specific tests.

The development trial on September 19 produced a ninth workflow with fourteen source-matching procedure items. A later native Intelligent cycle completed with an independently reviewed no-change result. A long native Private trial timed out during compaction without producing a draft; that remains a failed acceptance case and must not be represented as shipping-ready.
