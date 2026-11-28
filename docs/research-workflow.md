# Athena research workflow and evidence ledger

This implementation uses Athena's existing TaskManager, Pi sessions, file grants,
process receipts and SQLite storage. It is an Athena implementation inspired by
the reusable research direction described in Tencent's
[Hyra 2.0 announcement](https://hy.tencent.ai/research/hyra2), linked from the
[official Hyra-results repository](https://github.com/Tencent-Hunyuan/Hyra-results).
It does not import a Hyra agent framework or claim to reproduce Tencent's internal
research infrastructure.

## Running a study from chat

For new research runs the selected main model writes the study objective, ordered
steps and acceptance criteria through `plan_research`. It may inspect granted inputs
and existing project papers while planning. TaskManager requires a saved plan before
delegating work or starting a remote search. Expand **Research progress → Research
plan** to see the steps and criteria sent by the coordinator. A revised plan is
recorded alongside earlier plans in the research board.

Create a project with the research option selected and choose its local work folder if desired. The host records the resolved directory and Git branch. Attach each input through the composer to grant access. The first conversation opens immediately. Choose the model and reasoning level, attach the data or supported LaTeX template, and send the research question. Changes to the conversation model apply to the next request.

The **Research progress** tab reads the plan, bibliography, tool calls, condition tables, review receipts and compilation from TaskManager. Expand a stage to open the worker and its attempts in Workflow. Select a condition table to inspect the producing program, result version and its granted original inputs. **Manuscript preview** shows saved preliminary sections during the experiment, then the reviewed revision, compiled pages, source links and downloads. The existing editor remains available there.

The coordinator can search public Crossref using the project's research permission. A verified external MCP with a `browser` or `computer` capability can read pages or operate a GUI using its declared tools. Enable and check that connection in Settings. System-browser navigation has its own history. A citation to a visited page needs the URL and quoted text in the returned tool receipt. The host records the retrieval time and scope. Crossref citations retain the DOI and the metadata or abstract actually received.

In **Settings → Models & connections → Worker models**, assign a saved profile and an optional supported reasoning level to general work, literature research, mission planning, experiments, verification, manuscript writing, editing and independent manuscript review. An unassigned role inherits the effective conversation model. TaskManager snapshots the assignments and their account references when accepting the request. Editing them affects the next request. The linked manuscript run keeps the same assignments.

The coordinator or a literature worker can search by public topic or DOI. The host saves a readable note for each retrieved record under `Athena Library/<project ID>/` in the chosen folder. Projects without a selected folder use their own Athena-managed project directory. Supported open originals include Europe PMC article XML, arXiv PDFs resolved from arXiv DOIs, and JOSS publisher PDFs. When the original is unavailable, Knowledge shows the metadata or abstract obtained. PDF text indexing uses the local `pdftotext` program when available. The original download is verified against its stored SHA-256.

Open **Knowledge** to inspect, search or download these editions. A later conversation can use `search_project_library` and `read_project_paper` to retrieve the stored text and pass the exact source ID and version to the manuscript. Different projects can share a parent folder and retain separate libraries. The optional live browser acceptance test in `qa/library-roles-browser-test.mjs` (under the frontend package) exercises publisher retrieval, on-disk storage, model routing and reuse after restart.

Once the experimental reviewer supports exact output versions, the coordinator hands those results and their sources to the manuscript run. `record_experiment_table` resolves an array within a versioned JSON artifact to count the actual conditions. Paused work can be resumed at the latest saved checkpoint in its conversation. A repeated resume uses its existing receipt. An edited manuscript revision needs its own review and compilation.

## Adaptive experiment missions

For a quantitative question with a stopping criterion, the main coordinator can call
`run_experiment_mission` after saving its research plan. It supplies the plan ID,
fixed protocol and units, a result filename and JSON path, threshold and direction,
explicit input grants and a budget of one to eight trials. A plugin measurement
can specify an enabled server and tool. The host checks the producing invocation
on every trial. Each research run supports one fixed contract.

The experiment mission planner is a separate Pi session with a selectable model
and reasoning level in model settings. It receives the research objective and
prior measured outcomes and the worker's observations about its method. It returns either a new experiment instruction with a
reason and optional parent trial, or a reason to stop. TaskManager schedules the
planner and the experiment worker as direct children and reuses their sessions.
A selected parent trial can grant its pinned result to the next worker.

TaskManager reads the numeric metric from exactly one matching artifact produced
by the accepted worker attempt. It stores the version, digest, process identity,
input versions and evidence ID. Missing or ambiguous outputs count as trials.
The planner can change course after a miss. The host stops at the threshold or
trial limit. A separate reviewer checks the scientific method and the original
evidence before the manuscript handoff. Expand **Experiment** in the research
panel to see the decisions, parent trials, results and best measurement.

The SQLite checkpoint includes the accepted planner and worker attempts. Opening
the latest conversation and selecting **Resume from saved checkpoint** reconciles
an interrupted run. Completed measurements and evidence receipts are reused.
A terminal mission tool call returns its stored outcome. Waiting for a child
releases the coordinator's model slot.

The division of research responsibilities follows the published Hyra 2.0 design.
The fixed metric and best-result record draw on autoresearch. Explicit parent
trials preserve a branch history as in AI Scientist-v2. Athena executes one
new measurement at a time. [Hyra 2.0](https://hy.tencent.ai/research/hyra2) ·
[autoresearch experiment protocol](https://github.com/karpathy/autoresearch/blob/master/program.md) ·
[AI Scientist-v2](https://github.com/SakanaAI/AI-Scientist-v2)

The browser acceptance scenario uses the CadQuery example plugin, Playwright,
a local controlled model provider and the article template. Run
`node athena-backend-handoff/athena-codex-ui/qa/mission-browser-test.mjs`
from the repository root. Set `ATHENA_MISSION_CASE` to `budget`, `missing`, `restart` or
`routing` to exercise exhaustion, missing measurements, single-slot recovery during
planning or run-pinned planner model selection.
`ATHENA_BROWSER_EVIDENCE` selects the recording and receipt directory.

## Implemented flow

1. The coordinator records the question, acceptance criteria and planned stages
   with `plan_research`.
2. Existing direct child tasks perform the requested work with their actual tools
   and granted inputs. They keep the existing model, account, cancellation and
   retry behavior.
3. `add_research_evidence` records only actual input or result IDs. The host resolves
   and reads each target, checks access and hashes its bytes. Version, digest,
   size and artifact producer task/attempt/process identifiers come from the host.
4. The coordinator uses `request_review` with recorded evidence. The package is
   frozen and rechecked. A new direct child Pi session receives the original
   evidence and public review question. The author's conversation and hidden
   reasoning are not copied to this reviewer.
5. The registered reviewer calls `submit_review` with performed checks, findings
   and a verdict. The host rechecks the frozen evidence before accepting that
   structured receipt. A free-form assistant conclusion is not a review receipt.
6. The coordinator may record a reusable method using `propose_knowledge`. Its
   confidence level is computed from actual receipts. A tool's successful exit
   or an enthusiastic summary cannot set the level to verified.

There is one existing TaskManager scheduler. Mission records describe research
goals; they are not a new third agent role. Parent/child depth remains one.
No timer, autonomous wakeup, remote compute purchase or permission grant is
introduced by this ledger.

## Public tool contract

| Tool | Inputs | Persisted outcome |
|---|---|---|
| `plan_research` | `objective`, `acceptanceCriteria[]`, optional `stages[]` | Scoped mission with host-created ID |
| `add_research_evidence` | `missionId`, `title`, optional `summary`, `fileIds[]`, `artifactIds[]` | Immutable verified target references; at least one target required |
| `request_review` | `missionId`, `evidenceIds[]`, `question` | Frozen package and a separately bound reviewer child |
| `submit_review` | `reviewId`, `verdict`, `checks[]`, `findings[]`, optional `reproductionEvidenceIds[]` | Immutable receipt owned by the actual reviewer attempt |
| `remember_research` | `scope: project\|agent`, `text` | An explicit operational note in the selected memory scope |
| `propose_knowledge` | `missionId`, `title`, `method`, `rationale`, `applicability[]`, `evidenceIds[]`, optional `reviewIds[]` | Books entry with computed level and history |
| `get_research_board` | No arguments | Current mission, evidence and reviews; project Books and explicit project notes; calling agent's own notes |

Mutation request IDs identify the same logical operation. Reusing an ID with
different arguments fails. Source IDs and versions are technical references;
ordinary UI uses recorded titles and statuses.

Every mission operation must match an actual stored project, conversation, run
and attempt. Normal writes require a running, non-reconciliation attempt. Child
agents may record evidence or explicit notes, but only the coordinator may plan,
request reviews or propose shared methods. No tool grants are added by these
records or by loading a skill.

## Evidence and review invariants

`ResearchLedger` is in `runtime/research.ts`. It uses a versioned project metadata
record in Athena's existing `Storage`. Writes are synchronous SQLite updates;
asynchronous file checks reread the latest ledger before writing so concurrent
workers do not overwrite each other's records. Arrays are bounded, and returned
objects are copies.

The trusted resolver supplies the target kind, ID, project, conversation,
version, SHA-256 and byte count. For results it also supplies the actual producer
task, agent session, attempt and process, plus the process's input versions.
Models can request IDs but cannot supply a trusted digest, producer or success
state. The resolver must authenticate access and verify actual bytes; the ledger
does not grant access on its own.

Review preparation requires a real published artifact and rejects conflicting
versions of a target. Preparation and submission both re-resolve the full frozen
package. A changed hash, version, producer or input provenance invalidates the
submission; a new review of the new evidence is required.

The host calls `registerReviewer` after persisting the real child attempt and
before scheduling it. The reviewer must be a separate direct child session, not
the evidence author or the producing artifact's task/session. Only that exact
reviewer attempt may submit. The allowed verdicts are:

- `supported`: the recorded checks support the reviewed claim within their scope.
- `changes_required`: the reviewer found a problem that needs correction.
- `insufficient_evidence`: the available evidence does not establish the claim.

These are model review judgments with recorded evidence, not external peer
review or a guarantee of scientific correctness. Using separate sessions of the
same model does not establish model diversity.

The review's execution state and its verdict remain separate. Failed, cancelled
or paused attempts retain their own states. A manual retry calls host-only
`retryReviewer(previous, next)` before scheduling: it creates a new review ID,
records `previousReviewId`, pins the new attempt and preserves the earlier
receipt. The frozen input package is not silently replaced. The host directs the
retried child to submit to the new review ID. Restart does not automatically
rerun an interrupted review.

## Books levels and history

| Level | Required evidence |
|---|---|
| `observation` | An actual recorded evidence package; independent reproduction may be missing, incomplete or unsupported |
| `verified` | Every cited evidence record is covered by a supported independent review; the reviewer attempt actually succeeded; that same reviewer produced a separate result artifact from the exact pinned original input versions |
| `convention` | Explicit human action on an already verified entry, with a recorded reason |

Adding a source file reference beside an unrelated reproduction output is not
enough. The reproduction artifact's actual process input provenance must include
each pinned original input ID and version. Missing provenance, no original
inputs, a still-running reviewer or only a supported textual review leaves the
entry at `observation`.

Immediately before proposing knowledge, the host calls
`verifyKnowledgeEvidence` to recheck both the original targets and the review's
reproduction artifacts. Corrupting a reproduction file after the review does
not make that file eligible for a new verified entry.

Human `decideKnowledge` is an application RPC, never an agent tool. Its actions
are `convention`, `revoke` and `supersede`, each requiring a reason. Supersession
must name another active entry in the same project. Old methods, evidence links
and decision history are retained; revoked or superseded entries cannot be
silently reopened.

An entry does not authorize a file read, network request, process or plugin.
It records method, rationale, applicability and evidence. A reusable method is
not automatically installed or enabled as a skill.

## Project state, memory and UI

Mission/evidence/review records, explicit project notes, agent operational notes
and Books are separate collections. Project notes and Books are reusable within
the project. A model-facing board view includes only the calling agent's private
notes. Notes are deliberately authored summaries of next actions, observed
constraints and unresolved questions; the ledger does not extract hidden
reasoning or automatically copy conversation text into memory.

Mission `phase` is derived from real records: `planned`, `evidence_recorded`,
`review_pending`, `review_interrupted`, `reviewed` or `knowledge_recorded`. Interrupted
or cancelled reviewer attempts do not remain labelled as pending. These labels describe what
has been recorded. `reviewed` does not mean approved; `knowledge_recorded` does
not mean verified. The explicit `stages[]` are planned labels and are not rendered
as completed steps without corresponding execution evidence.

The existing Workflow and result artifact UI remain authoritative for actual
tool execution and downloads. Research records reference those results and do
not recalculate engineering values in the browser.

## Verification and remaining acceptance

`tests/research.test.ts` covers scope and role boundaries, exact host-resolved
targets, duplicate/conflicting requests, concurrent writes, changed evidence,
separate reviewer binding, structured immutable verdicts, cancellation during
verification, reproduction provenance, manual retry, Books confidence gates,
human decisions, history retention and restart/memory separation.

These are ledger tests against real SQLite storage with controlled file resolver
responses. `tests/manager-research.test.ts` additionally exercises the actual Pi
SDK, TaskManager, SQLite and Node CSV MCP worker using a controlled loopback model
provider. It follows skill loading, planning, calculation, evidence recording,
separate reviewer dispatch, actual CSV reproduction, structured review, Books
classification and restart downloads. A second case cancels the reviewer,
restarts without automatic execution, and manually retries with a new review
binding while retaining the original result and cancelled record.

Those manager tests replace only the WASI availability discovery flag to enable
the existing approved artifact-transfer gate on development hosts without the
native runtime. They do not call the WASI runner, and explicitly check that every
calculation used the actual Node measurement MCP worker. They are neither WASI
acceptance nor live-model review-quality evidence. Native Mac/ChatGPT acceptance
must identify the exact source/build SHA and distinguish a true independent
reviewer run from a controlled provider fixture.

An end-to-end acceptance starts with the actual measurement CSV, then records
the produced statistics, dispatches a fresh reviewer with the original CSV and
that exact artifact, independently recalculates, submits a structured verdict,
records a method, and reloads the same evidence and decisions after restart.
Changed input, malformed CSV, missing evidence, cancelled reviewer, failed
reproduction and changed output bytes must remain visible as their actual
outcomes. No unobserved external MCP or native-account case is marked passed.

## Replaying the browser verification

With Node 24, the prepared WASI runtime, a local TeX installation and Poppler available, install the QA folder's locked dependencies and Playwright Chromium. From the repository root run:

```sh
node athena-backend-handoff/athena-codex-ui/qa/research-browser-test.mjs
```

The scenario drives the served workspace and real host with a controlled Pi-compatible model provider. It records a WebM, screenshots, downloaded PDF, TeX, review manifest and checkpoint assertions under the directory it prints. Set `ATHENA_BROWSER_EVIDENCE` for a specific output directory and `ATHENA_CHROMIUM` for an existing Chromium executable. `ATHENA_LATEX_TEMPLATE_FILE` selects an attached template. `ATHENA_PUBLIC_METHOD=1` reads the pinned public reference, and `ATHENA_INTERRUPT_REVIEW=1` exercises cancellation and host restart during review. On Linux, `ATHENA_GUI_CHECK=1` exercises the independent calculator window with Python Tk, Xvfb and XTest.
