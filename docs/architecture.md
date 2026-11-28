# Architecture

Tauri launches the bundled Node sidecar, locks the workspace, then binds to an OS-assigned IPv4 loopback port. The private startup pipe carries the session and vault keys; a nonpersistent WKWebView uses an HttpOnly cookie. External navigation and popups are blocked and the web view has no general Tauri bridge.

The UI uses `/api/bootstrap`, `/api/rpc` and `/api/events`; see the [wire types](../athena-backend-handoff/athena-codex-ui/integrations/host-wire.d.ts). TaskManager owns runs, scheduling, file grants and artifact publication. Pi SDK owns the parent and child model sessions and their JSONL histories. A run freezes the coordinator model and any role-specific profiles. Workers inherit the coordinator selection unless their role has an assignment. SQLite stores workspace and run metadata. Restart does not dispatch unfinished work again.

The built-in CSV worker uses fixed code. Model-written analysis goes through the [WASI helper](sandbox-security.md). After exit, TaskManager publishes only the source that ran and the named, validated results, with version and SHA-256 receipts.

In a research project, TaskManager commits the chat input and model selection with the initial run. A supported, independently reviewed artifact can be handed to the manuscript workflow. The manuscript run retains the original role assignments and only receives the granted evidence versions. SQLite records the linked run IDs, evidence versions and review. Only the reviewing conversation may compile the approved revision. The research panel reads these records and the host event stream. [Research workflow](research-workflow.md) · [Typesetting](paper-orchestra.md)
