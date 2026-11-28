# Workflow graph and chat verification

This follow-up is based on source `6d38a5c0def941b00fc98f2d9eabdeabe60ab72f`, on `feature/athena-workflow-dag`. It keeps the prior research/extensions acceptance candidate intact. Release to `main` still requires a matching native Mac and actual ChatGPT-account acceptance report.

## Workflow graph

The chat-led research panel opens with a stage list. Its **Workflow graph** action opens the existing graph. Selecting a stage uses its owning task to select the corresponding run. Workflow opens in Graph view. Native task buttons show the reported task name, state, assigned agent and attempt, plus recorded background calculations. Selecting a task opens the existing attempt/tool/result detail; selecting a calculation opens its existing execution record. List view remains available. Fit, zoom, actual-size and a scrollable viewport support narrow panels and larger graphs.

The graph uses host records; it does not schedule work. Its inspiration is the small-task graph and explicit verification stages described by [Oh My Hermes / dag-ulw](https://github.com/rlaope/oh-my-hermes/blob/main/README.md). No third-party scheduler or source code was imported.

| Record | Meaning in the graph |
| --- | --- |
| `task.dependencies` | Recorded dependency arrows. Athena's `waitFor()` stores child IDs on the parent, so a child result points toward the waiting coordinator. |
| `task.parentTaskId` | Delegation association, drawn as a dotted link when that pair has no recorded dependency. It does not assert an execution order. |
| `task.runId` | The actual originating request. Graph, List, counts, calculation rows and selection must use the same request. Previous requests remain inspectable. |
| `attempt.status` | A preserved attempt outcome, including previous failures, interruption and manual retry. |
| `process.status` | The individual calculation outcome, independent of later task failure or retry. |
| `artifact.id` / version | The existing saved output reference. Graph navigation does not recalculate or replace the result. |

Delegation associations use the same layout direction as the recorded wait relation, so receiving dependency records does not flip the graph. Missing and circular relations remain visible as warnings; circular groups do not claim an invented execution order. Internal identifiers remain in technical details and action bindings. User-authored message text is preserved.

Research mission stages remain plans unless separate execution/evidence records exist. The graph does not imply arbitrary nested agents, a user-authored DAG execution engine, automatic repair scheduling or timed research wake-ups.

## Chat corrections

The UI previously accepted a draft consisting only of staged attachments, while the host required a nonempty message. The host now accepts a string message with at least one valid staged reference and runs the same ownership, session, project, version, byte and metadata checks before creating an attempt. Empty input with no files remains invalid. The UI transport retains that validated empty string instead of dropping the message field during parameter normalization.

Attachment names previously disappeared when live chat was replaced by saved history. The owning host attempt now projects display-only `attachments` metadata (`name`, `mimeType`, `size`) onto an exactly matched user message. This metadata exposes no file path, content or access grant. Existing credential redaction applies to its text. History and live rendering use text nodes for these labels, including a message with an empty body. The original user body and durable Pi transcript format remain unchanged.

Conversation updates preserve the pre-update scroll intent across nested message, child-activity and history replacements. A reader at the bottom follows new work and the final answer. A reader who scrolls up keeps that position; a later history replacement must not treat the temporary cleared transcript as permission to jump down.

## Repeatable checks

```sh
npm run check
node --test tests/manager.test.ts tests/history.test.ts
python3 athena-backend-handoff/athena-codex-ui/build.py
cd athena-backend-handoff/athena-codex-ui/qa
npm ci --ignore-scripts --no-audit --no-fund
npm test
npx --no-install playwright install --with-deps chromium
node chat-browser-test.mjs
```

The browser test launches the actual host and Pi transport with a controlled local compatible provider. CSV and RC tools, their workers, permissions, persisted records and result bytes are real. It exercises the rendered composer, streaming, inline activity, graph selection and zoom, result downloads, rejected-send recovery, cancellation, host reconnect and history restoration. It writes screenshots and a JSON report to `ATHENA_BROWSER_EVIDENCE`, or a fresh temporary directory by default. The `browser-chat` CI job preserves those synthetic files as an artifact.

`--fixture-smoke` runs the host/provider fixture and direct HTTP result checks without a browser. It must never be counted as rendered UI validation. Likewise, DOM contracts and browser tests with controlled responses do not verify real-account inference, native WKWebView rendering, two-account switching or cancellation during a short MCP calculation.

### Verified browser candidate

The `browser-chat` job in [workflow run 45564854286](https://github.com/yanaire/athena/actions/runs/45564854286) passed for PR head `337259cee5ce8c2c99a900106c273dfafda06029` on 2026-11-25. Its report identifies tree `d338268ff7f5756becd38170db835f15ce1f9595` and generated UI SHA-256 `ee9a54b2faf72b158283df136a909454b8e29de5a341c26ddf5aa01217437e89`, which match the resumed workspace before portability edits.

Fourteen scenarios passed with Chromium `151.0.7922.34` and locked Playwright `1.62.1`. These include text and attachment sends, incremental streaming, request-local child activity, hidden internal activity IDs, graph node/edge selection, fit and zoom, checked downloads, rejected-send recovery, stop response, host restart/reload, attachment-only history, and the limited Browser/Device panels. At widths 1440 and 760, the graph edge endpoints met their cards within 0.001 px. Completion followed the bottom of the chat; a reader who scrolled up stayed at the same `scrollTop` across the next stream update. CSV and RC downloads retained the exact worker-reported hashes.

All eleven evidence screenshots were visually inspected in the resumed session. The local DOM suites passed 246 checks and the host-only fixture repeated both numerical/download assertions. The local environment cannot create UNIX sockets required by Chromium, so rendered evidence comes from the successful CI job, not a claimed second local browser run. Native WebView2/WKWebView and real-account behavior still require their own acceptance evidence.

## Native acceptance follow-up

The Mac reviewer must build the exact final candidate SHA, then check CSV and RC delegation, graph request selection and process details, downloads with matching hashes, reload/restart preservation, failed/cancelled child retry, attachment-only submission and attachment labels after reopening. The report must separate actual-account observations from controlled-provider or CI results. Browser and Device limitations listed in [the capability audit](ui-capability-audit.md) remain intentional unfinished scope.
