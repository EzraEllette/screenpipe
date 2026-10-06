# Meeting title screenshots

These are isolated browser previews of the production `ListView`, `MeetingWorkspaceTabs`, and `MeetingSummarySurface` components, with fictional fixture data. They are not captures of the native app or a live AI run. Temporary preview code was removed from the patch.

Base: `adeac7f5b` (the list component is unchanged). All captures use a 1280 × 720 viewport, light theme, and the same fictional meeting context.

| Image | State |
| --- | --- |
| before.png | Recreated completed-summary baseline: app-name and missing titles remain generic. |
| after.png | Proposed saved records: two topic titles, a preserved descriptive title, and an unchanged unsummarized row. |
| idle.png | No summary yet; original meeting title. |
| working.png | Topic heading streams in the summary; original meeting title remains until save. |
| ready.png | Saved summary and descriptive meeting title. |
| failed.png | Failed generation; original title remains and retry is available. |

Persistence and recovery are checked separately by Rust regression tests. The previews illustrate those resulting record states; they do not call the Rust API or a model.
