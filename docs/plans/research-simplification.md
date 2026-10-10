# Purchase research simplification

Code audit baseline: `88523e287`, 2026-10-09. The dead-code and retired
vendor-search slices are merged and deployed; remaining slices are
proposals. Live acceptance is unfinished.
The owning backlog is [todos](../todos.md#import-pipeline-architecture).

## Responsibility and shared seam

Pi owns conversation, tool execution and durable continuation. Cubby's existing
`purchase-agent/run-agent.ts` already uses `PiHarness`, the Agents lifecycle and
`pi-durable` (1.0.2); `agents` is pinned to 0.26.0. Keep one execution owner.
Cubby owns admission, evidence integrity/disposal, transactional replay,
identifier ownership, money conservation, stock neutrality and outcome accounting.
Maintained purchase-import and product-enrichment skills own adaptive search,
source interpretation, exact-variant reasoning and packet-brand guidance.

The common seam is `research-tools.ts` / `purchase-agent-services.ts` and
`researchServiceFor`, followed by the existing evidence/admission/domain services.
Interactive and unattended adapters can call that same seam. This proposal does
not change the MCP HTTP handler, the separately owned caller-driven enrichment
launch/URL-capture mode, or spending-classification review.

Delete obsolete execution contracts in place and migrate their current callers;
do not add adapters that make retired launch or retry engines executable again.
Historical records remain readable through generic presentation. Preserve their
data and settled outcomes without preserving their old execution contract.

## Concrete deletion slices

| Current code/storage                                                                                                  | Proposed replacement and callers                                                                                                                                                                  | Deletions and acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retired vendor-search engine, Workflow wiring, schemas and specialized progress presentation                          | Known-vendor objectives use retained `research_mail_search`; mechanical discovery keeps its exact coverage/cursor protocol. Historical Runs remain generic readable records and refuse execution. | Implemented removal of the three engine files, old integration suite, Workflow class/binding/getter, old launch branch, source-target resolver, old schema exports, specialized report blocks and obsolete runbooks. Preserved failure/replay regressions on retained search and discovery. Merged as #1797 after independent Sol/high and Astra/high review and exact-head hosted checks; included in the verified subsequent main deployments. No tables or historical data deleted. Live mailbox acceptance remains open. |
| Unreferenced old coordinator schemas in `purchase-agent-services.ts`                                                  | The existing research tool input schemas; no production callers remain for the old declarations.                                                                                                  | Removed `purchaseAgentCommand`, `PurchaseAgentCommand`, `issueBrowserCommandInput`, `importOrderEvidenceInput`, `saveNavigationHintsInput`, `markHistoryExpiredInput`, `deferOrderForReviewInput`, `settleChargeHuntInput` and their dead imports. Stop/failure/settlement services remain.                                                                                                                                                                                                                                  |
| Handwritten research tool forwarding and Zod-to-TypeBox conversion in `purchase-agent/tools.ts`                       | Generate Pi descriptors and typed composition methods from the shared research contracts; migrate every research tool, retaining the separate photo-inventory family.                             | Replace the research registration list and schema conversion with generated adapters. Preserve coercion, original media, task binding, before-effect checks, retained outputs and Pi memo/domain operation IDs. Measure generated and handwritten bytes separately.                                                                                                                                                                                                                                                          |
| Purpose lists in shared client constants, agent input schemas, Run declaration and Workflow contract                  | Generate common presentation membership from Run declarations; retain distinct execution subsets. Migrate web/Apple report gating and shared activity projection together.                        | Delete handwritten common presentation twins. First reproduce missing `mail_import` report slots; do not equate all Run purposes with Workflow or Pi capabilities.                                                                                                                                                                                                                                                                                                                                                           |
| `RunOrderCandidate`, `research-legacy-mail.ts` (134), `research-legacy-objective.ts` (175), archived resolve contract | Historical reader/converter, then one `RunTarget` task representation for executable work.                                                                                                        | Conditional lossless migration only: inventory supported historical/in-flight shapes and transfer unresolved imported/covered dispositions first. Delete conversion code/table only after those readers have no remaining supported inputs. Production approval is required.                                                                                                                                                                                                                                                 |
| Import report/review slots and `__debug_event` operation special cases                                                | Existing generic entity/report/event projection, with evidence links and domain-specific action semantics                                                                                         | Inspect `repo/entity-report/run.ts`, `repo/activity.ts`, `repo/run-operation.ts` and native detail slots. Delete a bespoke renderer/stream only after the generic equivalent exposes the same actionable provenance and raw failures. No speculative new log table.                                                                                                                                                                                                                                                          |

### Implemented dead-code slice

Removed eight unused coordinator schema/type exports and their import (56 lines),
and three unused Gmail-search E2E fixture starters, their launcher and imports
(186 lines before import formatting). No runtime callers required migration.
The semantic deletion is 242 lines; the formatted diff removes **245 net
handwritten code/test lines**, with no replacement code, generated change, table
or data deletion.
The retained `vendor-order-mail-review.spec.ts` journeys cover saved raw failure
diagnostics, live progress, retry lineage/cancellation and multi-page scope
accounting through the replacement research dispatch. No test case was deleted.
Compiler/generator and hosted checks verify the removal; a declaration-only
regression would not guard behavior. That first slice did not retire the Workflow.

The retired Workflow slice removes **858 net handwritten production lines**
(901 removed, 43 added), **433 net test lines** (605 removed, 172 added), one
net generated line and 24 net documentation lines. The complete diff reduces
**1,316 lines**. It deletes three engine files, their integration and wrapper unit suites and two
obsolete runbooks, and adds no tables or data migration. All executable callers
and bindings are removed; historical purpose values remain data. Independent
Sol/high and Astra/high review, exact-head hosted checks and deployment completed.
The two deletion PRs together remove 1,534 net tracked lines, including tests and
documentation; this is a scoped measurement, not the entire rewrite's net size.
The forwarding-only adapter prototype below was rejected because it increased
code. A typed-composition replacement needs a demonstrated caller/sequencing
deletion before it has a defensible net reduction. The conditional schema slice can
remove one table and requires production approval; it adds no new table.

`RunEvidence`, `ImportHunt`, `MailboxCursor`, source claims, fact evidence,
retention receipts and source-exposure records are active contracts. Empty or
old row counts do not establish redundancy. `ResearchSourceExposure` records
which Run saw a mail checksum even when no claim was accepted; merging it into
fact evidence would lose that guarantee. `ResearchRetention` owns fenced model
state, object deletion and coordinator retirement in a recoverable sequence.
The AI usage ledger is already shared. Continue using existing Expense writers
instead of inventing a separate accounting framework.

## Run-purpose audit

Audited against main `5283a5120` on 2026-10-10. The shared vocabulary in
`packages/schemas/src/activity-fields.ts` already owns Run purpose values and
labels. The remaining subsets describe different capabilities:

| Declaration                                            | Contract and callers                                                                 | Why it remains distinct                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `agentImportRunPurpose`, `importRunAgentManifest`      | Pi agent inputs, dispatch, objective admission, retention, restart and tool mounting | Five executable research purposes; excludes discovery and file-import grouping.                         |
| `WORKFLOW_RUN_PURPOSES` in `workflow-runs/contract.ts` | Workflow controls, binding types and durable attempt identity                        | Only `mail_discovery`; it owns mechanical mailbox pagination rather than adaptive research.             |
| `IMPORT_REPORT_RUN_PURPOSES`                           | Generic Run reports and generated native report eligibility                          | Includes `file_import`; excludes photo, mail search and discovery because they have different reports.  |
| Run declaration's Imports saved view                   | Generated web/native filters                                                         | Includes photo, search and discovery for browsing; a saved view grants no execution or write authority. |
| `targetedImportPurpose` and `targetedImportStartInput` | Member launch/validation contracts                                                   | Targeted Product/Purchase inputs differ from Vendor account-sync inputs.                                |
| Purchase `capabilityMatrix`                            | Deterministic domain-write admission                                                 | Each purpose has distinct write rights; the model's mounted tools do not replace this enforcement.      |

There is no remaining duplicate purpose list in shared constants to delete.
Do not derive execution, report eligibility or write rights from the Imports
saved view, or expand Workflow execution to all Pi purposes. This audit changes
no callers, schema or authority and removes zero production lines or tables.
The next consolidation must demonstrate duplicate implementation, rather than
replace these small semantic declarations with a larger generic policy engine.

## SDK feature assessment

The [official feature table](https://github.com/cloudflare/agents#features) was
checked on 2026-10-09. Recommendations below are Cubby-specific inferences.
The upstream main branch is not proof that a feature exists in Cubby's pin.

| SDK capability                                                                       | Cubby decision and concrete deletion test                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistent state, SQL storage                                                        | Already used by the Run Agent/Pi. Keep Cubby's small admission/settlement/browser-delivery records where they own a distinct contract; inventory each before collapsing one into Pi state.                                                  |
| Callable methods, state/RPC synchronization, WebSockets, React hooks, vanilla client | Compare the existing browser broker/status stream with typed Agent RPC and synchronization. Adopt only if it deletes client/server projection or reconnect glue while preserving command/result identity and exact window ownership.        |
| Subagents/facets, Agent Tools and child timelines                                    | Optional bounded independent investigation within a Run; the household Run remains the outcome owner. A child timeline may replace rendering glue, but it must not introduce another Job/Run status model or independent billing authority. |
| Scheduling                                                                           | Reuse SDK wake/schedule for the existing Pi lifecycle. Mechanical Gmail discovery already has durable Workflow steps; adding another scheduler would duplicate recovery.                                                                    |
| AI Chat                                                                              | Pi already owns the model transcript. A second chat session stores duplicate history and does not simplify this researcher.                                                                                                                 |
| MCP HTTP/SSE/RPC, tool discovery, elicitation, WebMCP                                | Generated adapters can expose the common research service. Leave the separately owned MCP transport alone. Elicitation can serve real ambiguity; deterministic write policy remains server-owned.                                           |
| Workflows and human-in-the-loop                                                      | Appropriate for fixed pagination/backfills. Keep research adaptive in Pi and review proposals in the existing domain surface. No second approval/job engine.                                                                                |
| Email                                                                                | Gmail's retained history and authorization are already domain-specific. SDK email does not replace purchase classification, Gmail pagination or minimal unrelated-mail retention.                                                           |
| Browser Agents                                                                       | Evaluate only against an actual public/browser task and authenticated account boundary. It does not replace the member's signed Mac browser bridge by assumption.                                                                           |
| Code Mode                                                                            | Best candidate for removing repetitive tool forwarding and mechanical model turns. Generate methods from contracts; pilot bounded read composition before proposing write composition.                                                      |
| Sandboxed execution, virtual filesystem                                              | A retained-document workspace is useful only for a demonstrated multi-document task. It needs ownership, disposal, task binding and recovery tests. Do not duplicate retained source storage for convenience.                               |
| Observability                                                                        | Integrate with existing traces, AI usage and shared Run reports if it deletes custom tracing glue; keep raw upstream errors and credential-only scrubbing.                                                                                  |
| Voice, x402 payments                                                                 | No requirement in purchase research. Adding either would expand product/billing scope without deleting current code.                                                                                                                        |

### Pi

The [official Pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi)
and its [implementation notes](https://github.com/cloudflare/agents/blob/main/examples/next/harnesses/pi/NOTES.md)
describe experimental `PiHarness`, durable submissions, lifecycle wakeups and
tool recovery. Current upstream [Pi durable documentation](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
supports changing registry/agent tool selection and nested tool execution. Verify
those APIs against Cubby’s pin before replacing tool forwarding; preserve nested
replay keys and scalar coercion. Browser suspension and resumable task boundaries
still need explicit hosting. Cubby already uses
this ownership split. Audit its extra settlement/exposure records rather than
replacing Pi recovery with another generic engine. Preserve the existing
interrupted-write and retained-browser-delivery regressions.

### Forwarding-only prototype

A controlled registration prototype replaced eight handwritten Pi forwarding
registrations and duplicate service signatures with one schema/service/description
declaration and a generated adapter. It increased handwritten production code by
17 lines, added 23 generated lines and 45 preservation-test lines. Seven focused
runtime tests passed, including replay admission and original media; app typecheck
passed after supplying unchanged WASM declarations. An independent review found
that a static schema import would run before shortcode-registry bootstrap on a
fresh checkout. The prototype was discarded rather than shipped as a reduction.

Keep the existing shared runtime until bounded composition provides an actual
second caller and deletes mechanical model sequencing or other implementation.
Generate only after bootstrap dependencies exist. A registration-only migration
is insufficient evidence for adopting additional machinery. No model comparison,
production migration or live research ran in this experiment.

### Debug observation storage

The current browser debug-batch operation has one production caller:
`operations/run.server.ts` calls `insertDebugEventOperations`. That helper uses
the shared `insertOperation` writer with conflict-ignore event identity. Its
completed rows are observations, not executable recovery checkpoints. The
existing resend regression in `runs/operation.integration.test.ts` retains each
event once after a lost response.

`repo/activity.ts` projects these rows through three small kind-specific
branches: device source, event name and original diagnostic payload. RunProgress
stores typed discovery/suggestion snapshots, not equivalent diagnostic events;
ImageProcessingEvent belongs to image jobs. Neither is an existing generic
replacement for these Run observations. Changing stores would require new
payload/read contracts and a preserving historical transformation or permanent
dual reads. No measured deletion currently justifies that change.

Retain the existing writer and projection. No caller, file, table or test is
deleted by this audit; net code/schema reduction is zero. A future proposal must
preserve event identity, raw diagnostics, actor ownership, retention and
historical rendering, establish stronger coverage before deleting the resend
regression, and obtain approval for any production migration. Do not count a
renamed special case or a new event table as simplification.

### Code Mode and Computer workspace

The [official Code Mode package](https://github.com/cloudflare/agents/blob/main/packages/codemode/README.md)
is experimental. It generates types and supports isolated execution and
MCP/OpenAPI connectors. These supply composition and transport, not Cubby's
evidence authorization or transaction idempotency. A generic low-level request
escape hatch must not expose arbitrary domain writes. Its separate
[durable runtime](https://developers.cloudflare.com/agents/tools/codemode/durable-runtime/)
persists history, approvals and snippet execution; adopting that alongside Pi
would add a second execution owner. Evaluate bounded composition inside Pi first.

Pilot a generated `research` namespace with bounded independent reads. Each
method still passes through its normal authorization, spend check, operation
identity and task/source binding. Replaying an execution must replay each call's
original result; loop positions are not stable domain operation IDs. Restrict
network/environment access and time/output/tool-call limits. Public read results
remain individually inspectable. Original images/documents stay available to
the model outside an opaque scalar return. A browser wait returns a durable
pending command and ends the composition; reconnect resumes from persisted host
state, not a suspended in-memory JavaScript stack.

The [Pi example workspace](https://github.com/cloudflare/agents/blob/main/examples/next/harnesses/pi/README.md)
uses `@cloudflare/computer` for a SQLite-backed workspace and bounded host
callbacks. This is not a remote authenticated Chrome replacement. Its example
distinguishes replay-safe operations from `edit`/`exec`. A production workspace
proposal must demonstrate a real document-processing need, source disposal,
authentication boundaries, abort/recovery and measured deletion. The [computer package](https://github.com/cloudflare/computer/blob/main/packages/computer/README.md)
is explicitly preview-only and unsuitable for production use. No workspace
is introduced in the live-completion fixes.

## Failure-first migration and acceptance

1. Preserve named historical mail-search scenarios in the replacement retained-
   source harness before deleting their old test/starter. Assert scoped search
   cannot advance mailbox-wide coverage, including replayed pages and multi-order
   mail. Read active cloud instances before retiring the binding; infrastructure
   removal receives Astra/high as well as Sol/high review.
2. Exercise missing `mail_import` generic report slots and research root grouping
   with persisted headless state plus one small UI journey. Generate native
   presentation with the same declaration. Historical null lineage stays null.
3. For typed composition, first fail unauthorized/foreign source, stale target,
   repeated/parallel operation, cost-cap, browser-wait/reconnect, aborted execution
   and original-media tests. Keep write admission in the existing services.
4. Compare the current interface and generated read composition on a few synthetic
   unfamiliar-vendor/variant tasks: same model/version, effort, budget, sources
   and acceptance. Record tool/model calls, bytes, elapsed active time, charge,
   supported outcomes and unsafe writes. Separate interface changes from provider
   or browser capability changes. No large evaluation platform.
5. Inventory historical table rows/references and unsettled Pi sessions before a
   schema proposal. Review the exact lossless transform and preservation/readback
   plan with the user. No new production migration is authorized by this audit.

For every slice, report actual net handwritten/generated/test lines and table
count, migrated callers, deleted files, reused passing evidence, checks not run,
and sanitized exact-revision artifacts. Library adoption alone is not success.

## Live completion remains separate

The approved preserving `0025_purchase_research` cutover is complete. Remaining
acceptance includes the authorized live roster, known-vendor and unmatched-charge
backfills, full-history coverage and separately verified continuous new-mail
processing. A quota/auth/admission failure is not model-quality evidence.
Budgeted Gateway fallback is separately authorized within the existing pilot,
historical and continuous caps. Each paid transmission still requires durable
admission and known pricing. A bounded live attempt on main `fa218505e`
confirmed HTTP 200 with missing Content-Type: `event: error` carrying the exact
quota code followed two metadata event names (`response.created`,
`response.in_progress`). It was canceled after one failed subscription call with
zero metered API cost. This is now protocol evidence, but event names alone do
not prove empty output. The shared router now inspects a complete bounded
pre-output refusal and qualifying metadata before the SDK receives bytes,
then runs the existing durable paid admission. Non-refusal chunks are returned
unchanged; any output, tool, reasoning, unknown event or `response.failed`
prevents recovery. PR #1794 passed independent Sol/high and Astra/high review,
exact-head hosted checks and checksum-verified E2E artifacts before merging.
A fresh bounded attempt after deployment of `01dda8634` still received the
exact quota refusal, with no paid admission or gateway call; it was canceled
after one failed subscription call. The reason admission declined that stream
is not established by event names alone. Live paid acceptance remains open.
This proposal grants no additional spend,
production migration or household cleanup.

The forward image fix reuses a same-byte item attachment under the existing
Product lock, retains new source support and cleans only newly staged redundant
images. Historical duplicates and null hashes require separate reviewed cleanup.
Explicit retries may reverify targets despite complete field coverage; automatic
admission still suppresses unchanged attempts. Settled predecessors are immutable.

### Vendor-search retirement regression map

The old execution engine has no production launch caller. Read-only production
Run and Workflow inventory established no active search work before binding
removal. Historical persisted rows are retained, including original input and
progress JSON; the shared control boundary refuses retired execution before a
write. This is a direct removal, with no retry or transport compatibility adapter.

| Removed regression                                          | Retained coverage                                                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page commit/replay, saved cursor and canceled retry         | `research-mail-search.integration.test.ts`: exact scoped paging, frozen-page dispatch replay, cancellation and source/task/account ownership; discovery checkpoint/retry regressions |
| AI Gateway 429 never counts/advances failed acquisition     | `retains the frozen page after an AI Gateway 429 without advancing scoped or broad coverage`; Gmail provider's `retries a transient Gmail 429 and honors Retry-After`                |
| Raw upstream diagnostic and Sentry event survive failure    | `keeps a failed page's raw diagnostic and Sentry event on the retained discovery Run`                                                                                                |
| Quiet ended instance fails, waiting instance remains active | `fails a quiet discovery Run whose instance ended and leaves a waiting one`                                                                                                          |
| Dispatch refusal leaves no phantom live Run                 | Existing discovery authorization/launch and retained research dispatch-failure regressions                                                                                           |
| Retired retry preserves historical evidence                 | `refuses retired vendor-search retry without changing historical evidence` — meaningful RED changed cursor/failure before the control refusal; GREEN preserves the row               |

The vendor-search unit test only asserted its retired wrapper's call shape;
current retained-source integration covers bounded acquisition, query isolation,
Spam/Trash exclusion and frozen-page replay. Its deletion removes no distinct
current runtime contract. Historical input/checkpoint visibility is verified
through the persisted generic report before refusing execution.

The vendor-only stable step-name and twelve-wait orchestration assertions are
removed with their unreachable engine. Retained discovery's three step-sequence
checks cover checkpoint-before-next-page, failure, and cancellation. Adaptive
research keeps provider diagnostics and frozen acquisition replay; it does not
retain the retired fixed vendor-page choreography. Live model acceptance remains
separate from these deterministic checks.
