# Purchase research simplification

Code audit baseline: `d884dcd40`, 2026-10-09. This is a deletion proposal,
not a claim that the rewrite is already small or that live acceptance is done.
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

## Concrete deletion slices

| Current code/storage                                                                                                    | Proposed replacement and callers                                                                                                                                                                                                                     | Deletions and acceptance                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gmail/search-job.ts` (423 lines), `gmail/search.ts` (87), `gmail/vendor-search.ts` (38), vendor-search Workflow wiring | Known-vendor objectives use retained `research_mail_search`; keep mechanical mailbox discovery and its exact cursor protocol. Migrate `tests/e2e/fixtures-mail.ts` and `search-job.integration.test.ts` scenarios before removing their old starter. | Delete the three files (548 production lines), `VendorMailSearchWorkflow` only, its binding/getter/generated declaration, launcher purpose branch, vendor-search-only workflow steps and presentation hooks. Keep historical `mail_search` purpose/rendering. Check active Workflow instances and historical Runs before binding removal. |
| Unreferenced old coordinator schemas in `purchase-agent-services.ts`                                                    | The existing research tool input schemas; no production callers remain for the old declarations.                                                                                                                                                     | Remove `purchaseAgentCommand`, `PurchaseAgentCommand`, `issueBrowserCommandInput`, `importOrderEvidenceInput`, `saveNavigationHintsInput`, `markHistoryExpiredInput`, `deferOrderForReviewInput`, `settleChargeHuntInput` and their dead imports. Keep stop/failure/settlement services.                                                  |
| Handwritten research tool forwarding and Zod-to-TypeBox conversion in `purchase-agent/tools.ts`                         | Generate Pi descriptors and typed composition methods from the shared research contracts; migrate every research tool, retaining the separate photo-inventory family.                                                                                | Replace the research registration list and schema conversion with generated adapters. Preserve coercion, original media, task binding, before-effect checks, retained outputs and Pi memo/domain operation IDs. Measure generated and handwritten bytes separately.                                                                       |
| Purpose lists in shared client constants, agent input schemas, Run declaration and Workflow contract                    | Generate common presentation membership from Run declarations; retain distinct execution subsets. Migrate web/Apple report gating and shared activity projection together.                                                                           | Delete handwritten common presentation twins. First reproduce missing `mail_import` report slots; do not equate all Run purposes with Workflow or Pi capabilities.                                                                                                                                                                        |
| `RunOrderCandidate`, `research-legacy-mail.ts` (134), `research-legacy-objective.ts` (175), archived resolve contract   | Historical reader/converter, then one `RunTarget` task representation for executable work.                                                                                                                                                           | Conditional lossless migration only: inventory supported historical/in-flight shapes and transfer unresolved imported/covered dispositions first. Delete conversion code/table only after those readers have no remaining supported inputs. Production approval is required.                                                              |
| Import report/review slots and `__debug_event` operation special cases                                                  | Existing generic entity/report/event projection, with evidence links and domain-specific action semantics                                                                                                                                            | Inspect `repo/entity-report/run.ts`, `repo/activity.ts`, `repo/run-operation.ts` and native detail slots. Delete a bespoke renderer/stream only after the generic equivalent exposes the same actionable provenance and raw failures. No speculative new log table.                                                                       |

The first slice has **548 exactly counted full-file production lines** available
for deletion plus wiring. A roughly 650-line combined estimate from the initial
audit is not an accepted net result: fixtures, shared helpers, generated output
and historical rendering must be measured from the actual diff. The generated
adapter slice has no defensible net estimate until a small prototype exists.
The conditional schema slice can remove one table; it adds no new table. Current
fixes add regressions and remove no tables or historical data.

`RunEvidence`, `ImportHunt`, `MailboxCursor`, source claims, fact evidence,
retention receipts and source-exposure records are active contracts. Empty or
old row counts do not establish redundancy. `ResearchSourceExposure` records
which Run saw a mail checksum even when no claim was accepted; merging it into
fact evidence would lose that guarantee. `ResearchRetention` owns fenced model
state, object deletion and coordinator retirement in a recoverable sequence.
The AI usage ledger is already shared. Continue using existing Expense writers
instead of inventing a separate accounting framework.

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
tool recovery. Tools are fixed when a session is created; browser suspension
and resumable task boundaries still need explicit hosting. Cubby already uses
this ownership split. Audit its extra settlement/exposure records rather than
replacing Pi recovery with another generic engine. Preserve the existing
interrupted-write and retained-browser-delivery regressions.

### Code Mode and Computer workspace

The [official Code Mode package](https://github.com/cloudflare/agents/blob/main/packages/codemode/README.md)
is experimental. It generates types and supports isolated execution and
MCP/OpenAPI connectors. These supply composition and transport, not Cubby's
evidence authorization or transaction idempotency. A generic low-level request
escape hatch must not expose arbitrary domain writes.

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
authentication boundaries, abort/recovery and measured deletion. No workspace
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
Subscription-required routing and metered authorization caps remain unchanged;
no paid fallback, new migration or household cleanup follows from this proposal.

The forward image fix reuses a same-byte item attachment under the existing
Product lock, retains new source support and cleans only newly staged redundant
images. Historical duplicates and null hashes require separate reviewed cleanup.
Explicit retries may reverify targets despite complete field coverage; automatic
admission still suppresses unchanged attempts. Settled predecessors are immutable.
