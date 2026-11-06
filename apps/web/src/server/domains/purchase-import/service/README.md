# Purchase import: Mail import, member imports and Burn-down

[ADR 0010](../../../../../../../docs/adr/0010-mail-import-unattended-burn-down-interactive.md)
splits purchase work in two (vocabulary: [terminology](../../../../../../../docs/guide/terminology.md#purchase-research)):

- **Mail import** (unattended): Gmail discovery classifies and retains order
  Email, and a Pi agent turns it into Purchases, Expenses, Product resolutions
  and Email links. It reads only Email; there is no browser and no web search.
- **Burn-down** (interactive): a member's Claude or Codex session works the
  Research queue (the `research-queue` saved views over existing data-quality
  gaps) with its own browser, writing through ordinary MCP writes that retain research in editable notes.

Both use the same public tools. Cubby owns ownership, retained-Email checksums,
replay, identifier collisions, money conservation, stock neutrality and safe
writes; the caller owns research and judgment. An absent caller leaves work
pending: nothing here starts Product research.

## Mail import, end to end

1. **Discovery** (`gmail/discovery.ts`, the `MAIL_DISCOVERY` Workflow) pages a
   connected mailbox (`-in:spam -in:trash`), freezes each provider page in
   `Run.progress`, and replays it until its page commits. `gmail/ingest.ts`
   classifies each message (`gmail/triage.ts` rule/decision model, then
   `gmail/relevance.ts` for uncertain mail) and records the deciding stage and
   reason on `Email`. Jev and Clef own their decisions: bounded-view
   incompleteness is sent to the model and reported in previews, but does not
   replace a definite choice with uncertain. Negative decisions still require
   high model confidence. Related evidence concerns the recipient or household,
   including forwarded confirmations; newsletters about an author's or other
   people's shopping are unrelated. Recommendations explicitly confirming a named
   product the recipient bought or returned remain related. Campaign metadata
   alone does not supply that confirmation. Gift thresholds, shipping benefits, generic order or
   security assurances and back-in-stock notices do not confirm a transaction;
   omitted promotional labels alone do not require abstention. The prompt requests
   uncertainty when body text is clipped without visible confirmation, since the
   purchase-cue scanner does not cover every transaction phrase. Missing or
   incomplete original body bytes remain a
   rule exception before inference; model abstentions reach the relevance
   fallback. The fallback uses the same Email compactor, including preheaders,
   and retains its missing-evidence guard. Hidden image destinations on pictures
   explicitly at most one pixel in both dimensions are tracking metadata;
   their bounded labels remain in the model view as readable metadata (including
   explicit transaction confirmations), and
   surrounding links still participate in evidence checks. Omitted or clipped
   pixel labels retain incompleteness; larger hidden pictures retain their guards.
   Accessibility-only `aria-hidden` does not hide visually rendered Email
   text or pictures; actual CSS visibility and `hidden` attributes still do.
   Hidden HTTP(S) links and their labels are retained in the bounded link set;
   omitted cue-bearing links and cues lost during URL normalization still mark
   evidence incomplete. Hidden receipt text marks evidence incomplete only
   when the visible text and preheader do not repeat its purchase cues
   (responsive mobile/desktop duplicates are complete); hidden image evidence
   keeps its completeness checks.
   Referenced `cid:` pictures count as available only when their exact MIME
   Content-ID image bytes fit and reach the relevance interpreter. Missing,
   unsupported or oversized parts remain incomplete.
   Confident positives proceed to extraction/matching; only uncertain relevance
   reaches the relevance fallback. Related originals become `OrderMail`; unrelated
   mail keeps only its provider identity. Coverage is checkpointed with a
   compare-and-swap in the same transaction as the page's events
   (`gmail/persistence.ts`).
   A member's **Reclassify** (`gmail/reclassify.ts`, MCP `purchase_import.email_reclassify`)
   reruns these stages, including the relevance model, for up to 200 selected
   Emails through the same ingest path in its `reclassify` mode: the result is
   history, it replaces Relevance only without dropping retained content or an
   import, and it never overrides a member resolution (ADR 0011).
   Each relevance rerun stores a versioned publication-receipt checkpoint in
   `Run.progress` before work, after every reached Email, and with the deferred
   tail on completion. The frozen
   selection and checksums remain in `Run.input`. `run_read.work_snapshot`
   exposes `mailReclassification` through a narrow member-owned read: selected
   Email codes/checksums, exact receipts, retained notes, and separately labeled
   immutable classification observations. A client timeout does not imply the
   Run stopped: recover its receipts before deciding whether to rerun only
   deferred work. `complete` means the entire roster has receipts, including
   deferred outcomes; it does not mean every Email was classified. Legacy Runs
   have null receipts; notes can be truncated and observations do not establish
   publication outcomes. A failed outcome can follow publication if read-back
   fails, so it also requires reconciliation before retrying. Missing Email identities are null, never raw UUIDs.
   Receipt persistence follows publication in a separate transaction: an abrupt
   termination between them leaves an unknown outcome, not permission to rerun.
   The status header reuses the canonical Run projection without entity-quality
   hydration. Preview reruns and discovery retain their existing progress contracts.
2. **Admission** (`mail-import-run.ts`) freezes up to 50 Emails' checksums into
   one `mail_import` Run with a RunTarget per Email, assigns ownership through
   `Email.runId`, and dispatches `start_or_resume` to
   a `purchase.dispatch` Job in the admission transaction (`dispatch.ts`). Each paid call checks
   the Run is still executable and draws from the household AI budget
   (`run/service/execution-transport.ts`, `server/ai/budget.ts`).
   Existing discovery wakes also recover untouched automatic unresolved work
   when its retained original changes, its sender becomes verified, or accepted
   source evidence now establishes its exact order on the member's own Vendor
   account. Source and accepted-evidence fingerprints deduplicate attempts;
   Purchase edits and unchanged evidence do not reopen work. Accepted source
   publication must be newer than the latest unresolved outcome;
   older evidence does not trigger a cutover retry. Recovery first pages bounded
   untouched gaps, then reads only Purchases for their printed identifiers and
   verified Vendors. It does not build a sender-by-Purchase cross product or
   search every imported original's full body. Admission rechecks
   literal identifiers, current source bytes, source ownership, live dispatch
   leases and retained member intent under the existing evidence-write scope.
   A successor retains the predecessor's frozen roster/outcomes and records the
   ownership transfer. Foreground, retired, reviewed and excluded work stays held.
3. **Pi** (`agent-host.ts`, `server/domains/purchase-agent/`) runs on the generic agent
   tools (`claim_next_import_work`, `report_agent_progress`,
   `stop_import_run_for_review`) plus the MCP actions its manifest mounts
   (`packages/schemas/src/import-run-agent.ts`), called in process through the
   MCP handler with a run-bound delegation (`agent-services.ts`
   `mcpFetch`). Instructions: `.agents/skills/purchase-import/references/mail-import.md`
   via `server/domains/purchase-agent/service/import-run-workflows.ts`.
   Stronger-model escalation is explicitly requested with a blocker category.
   Missing evidence, member decisions, held sources and transient failures do
   not escalate. An unresolved disposition or refused preparation does not
   automatically spend a stronger-model turn; repairable extraction, identity,
   contradictory evidence or an unclassified reasoning gap may request one.
   Its durable per-Email decision survives re-claims and coordinator recovery.
   When Claude escalation credit is already known unavailable, production
   checks Sol's free funding before selecting it directly; it does not spend a
   failed Claude request to reach the existing provider-ladder alternative.
   The selected model is retained in the escalation receipt across recovery.
   The RunOperation ledger owns claim-evidence extraction budgets across Runs: two
   primary submissions (initial plus repair) and one escalation submission.
   Identical extraction replay does not consume another attempt; repeated claims
   and successor Runs retain the budget. The claim binds the original checksum,
   sender proof and accepted order-source context; display-name and Purchase-date
   edits do not reset it. Writer classification uses trusted MCP error metadata,
   never Email text. Held-source refusals are exempt. Known validation refusals
   return without automatic replay; unknown writes retain their reservation until
   exact writer recovery. Generation response hooks only
   account for submissions; they never publish dispositions.
   Exhaustion records an unresolved gap through the delegated mail-resolve writer,
   using a stable operation ID and the issuing generation fence.
   `import_extracted_order` handles complete, admitted, attachment-free Email.
   It generates stable IDs and runs the existing prepare/commit tools as durable
   nested calls. Newly discovered Product candidates return the preparation for
   review instead of creating a possible duplicate. Incomplete source views and
   complex originals retain the exception path.
   After a known, non-conflicting publication, the same durable tool claims and
   returns the next Email with its evidence. The model does not spend a separate
   turn coordinating that claim. Unknown writes and conflicts do not advance.
   A Mail import claim (`operations/mail-import-claim.ts`) returns the
   claimed Email's compact read (`readMail`, bounded by `fitMailRead`). Before
   claiming, it settles leading roster Emails a Mail import rule decides
   (`service/mail-import-rule.ts`, revision `MAIL_IMPORT_RULE_REVISION`)
   through `purchase_import.mail_resolve`'s own writer, with no model call: a shipped,
   delivered or duplicate confirmation notice (subject phrase; no refund,
   cancellation, return or failure wording, including item cancellations in
   the body) whose complete compact read's printed order identifier
   (`purchase_cues`) names exactly one live Purchase of the sender-proof
   Vendor (`senderProofVendor`) on the Email owner's own account there, with
   no retained attachment bytes and an accepted import source (an unitemized
   Purchase goes to the coordinator, which can itemize it from the notice),
   links as that event (proposer `heuristic`, Assessment producer `rule`); an
   exact USPS or FedEx carrier notice classified related records its package,
   then links only the Purchase that Shipment already holds or settles
   unresolved, and goes to the coordinator if the writer holds the package; an
   Email the classifier confidently called unrelated (stage `rule`,
   `decision` or `model`, in a Run the member did not select, from a sender
   that proves no Vendor) resolves
   `unrelated` (its resolution observation carries the revision). Everything else,
   an incomplete or paged compact read, and any refusal `purchase_import.mail_resolve`
   returns, goes to the coordinator. A rule
   link skips the `mail-attribution` judgment: on the owner's own account it
   cannot change what the link writes. An Email handed to the coordinator
   carries the rule's evidence as `known` (the sender-proof Vendor, the
   recognized order identifiers and up to five live Purchases holding one),
   so the coordinator skips the Vendor and order-id lookups most Emails
   otherwise start with.
4. **Writes**: `purchase_import_read.mail_read` reads a retained Email (`mail-tool.ts`
   `readMail`); `purchase_import.prepare/commit` (`import-orders.ts`) import an
   order through `writer.ts`, and a mail-sourced commit (message or
   attachment) links and settles the Email as the Purchase's confirmation,
   and a commit that creates Products starts a `scheduled` category
   suggestion sweep for them when AI refresh is active
   (`import-category-sweep.ts`);
   `purchase_import.mail_resolve` records a lifecycle link, an unresolved gap or an unrelated
   disposal (which deletes the retained copy unless a reviewed decision or
   import uses it; the daily catch-up retries a disposal lost after its
   disposition, and a repeated `unrelated` resolve replays without the
   copy). A Mail import Run may read its member's retained Emails from the
   mailboxes it admitted, but writes (prepare, commit, resolve) only the Emails
   on its roster (`mail-run-membership.ts`), and is refused by every mail call
   once it is cancelled, finished, retired or deleted. Naming another original
   in `prepare` or a `linked` resolve admits it to the roster
   (`operations/mail-source-admission.ts`) only when the `mail-source-relation`
   decision confidently finds the same purchase as a roster Email (or, along
   a `via` path, as the Email before it, the first against the roster) and
   `mail-attribution` finds the recipient's own transaction, within the
   Run's execution claims. Supporting originals append past admission's 50
   targets up to the roster backstop (`MAIL_RUN_ROSTER_LIMIT`), so a full
   batch never strands a notice whose original is still unclaimed. A Run the member did not
   explicitly select (`trigger` other than `foreground`) prepares a Purchase
   only from an Email attributed to its recipient: forwarding alone never
   proves ownership, and an unattributed Email may still link to an existing
   Purchase without creating the recipient's VendorAccount. Attribution
   (`service/mail-source-judgment.ts`) always asks `mail-attribution` (apart
   from the rule link above), with
   the owner and household members as trusted evidence: the owner
   LedgerParty's linked sign-in email and connected Gmail profile address
   (cached per isolate by `repo/mail-owner.ts`; an unreadable profile is
   reported to Sentry and named in the judgment's warnings), compared
   lowercased, `+tag`-free and, for Gmail, dot-free on addr-specs only.
   Own mail (`service/mail-owner.ts`: an owner address in To, a sender who
   is neither the owner nor another live member, no `X-Forwarded-*`,
   `Resent-*` or `X-Google-Original-From` header, no `Fwd:` subject and no
   forwarded-message marker in the text or HTML body) defaults to
   `recipient` unless the model answers `third_party` with high confidence;
   evidence too large for the model stays `uncertain`, own mail included,
   since the default needs an actual answer. Delivered-To or Cc alone is not
   own mail. Any other Email needs a
   high-confidence answer. A refusal reports the label, its basis
   (`owner_default`, `model` or `oversized`), the model's label and
   probability, and any owner-evidence warnings. Payment, refund and
   transfer Emails reach `finance.converge`, whose mail branch uses the
   checksum- and literal-verified `mail-financial-event` preparation
   (`service/mail-financial-event.ts`, revalidated by
   `repo/mail-financial-event.ts`). New preparations may not
   name the retired `browser_order` source kind; stored rows keep it.
5. **Settlement**: A normal Mail coordinator answer first rechecks runnable
   work through the leased `claim_next_work` operation. If an Email remains,
   the generation's yield hook continues with its current claim, preserving
   the claim result on replay. A source-specific blocker is resolved as
   `unresolved`, then the coordinator continues the batch; an unavailable
   escalation does not block unrelated Emails. Explicit Run review, stopped
   Runs and exhausted rosters still settle. Pi's settled submission reconciles the Run
   (`run-review.ts` `reconcileSettledRun`); the daily cron expires stale Runs
   and destroys settled Runs' transcripts (`run-retirement.ts`), oldest
   first in bounded batches; the destroying call and an immediate follow-up
   that reaches a fresh, empty coordinator let one pass stamp
   `Run.retiredAt`, and a failing coordinator does not block the Runs behind
   it. Runs of retired purposes are destroyed by their stored
   coordinator identity without loading the current agent. Once disposal is
   authorized the coordinator writes a durable fence table, refuses every
   entry point (also after a restart) and drains admitted ones before
   deleting, so nothing recreates storage before `retiredAt` is stamped; an
   inventory holding only the fence is empty. Retirement atomically dismisses
   only the machine-written Run execution alerts for coordinator inactivity or
   an unfinished coordinator, and each pass closes those alerts on already
   retired Runs. Finding evidence, genuine source review (including Run-targeted
   review), unresolved entity and settlement work, and Run provenance remain.
   Readers exclude obsolete retired execution alerts before maintenance catches
   up. A stored finding whose fix kind is retired reads as having no
   executable fix (`storedImportFix`).

## Member imports

A member (or their Claude/Codex session) calls the same
`purchase_import.prepare` without a Run: it opens a `file_import` Run keyed by
the operation id and returns its `RUN-` code, which `commit` names in
`_runExecution.run`. Each order names its Vendor (`vendorId`, or `vendor.name`
to reuse an exact-name Vendor). Replay is by operation id (`RunOperation`), and
the `ImportSourceClaim` fence keeps a source from importing twice. A receipt
photo becomes a Purchase through ordinary booking and attachment; its attached
receipt puts the Purchase in the Research queue through `purchase_itemization`
until a session itemizes it.

## Where to look

| Need                                       | File                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| Public mail tool (read, search, resolve)   | `mail-tool.ts`, `packages/schemas/src/mailbox-research.ts`             |
| Import writers                             | `import-orders.ts`, `writer.ts`, `writer-policy.ts`                    |
| Mail import admission                      | `mail-import-run.ts`                                                   |
| Run lifecycle, controls                    | `run-service.ts`, `run-review.ts`                                      |
| Agent capabilities per Run purpose         | `capabilities.ts`                                                      |
| Gmail discovery, classification, retention | `gmail/`                                                               |
| Pi host and services                       | `agent-host.ts`, `agent-services.ts`, `server/domains/purchase-agent/` |
| Findings and their fixes                   | `findings.ts`                                                          |

## Hidden dependencies

Live `eval:mail-replay` requires `MAIL_REPLAY_PRICING_FILE` (an official
models.dev `?type=all` snapshot) and `MAIL_REPLAY_BUDGET_FILE` (an exclusive
JSON ledger with `limitUsd`, `accountedUsd`, `outstandingUsd` and `stopped`).
One loopback admission server serializes full catalog-window reservations for
both peers before every physical call. It reconciles exact stored receipts
between requests, so sequential calls can reuse unused capacity without
partitioning the allowance between coordinator and other features.
Frontier requests require the subscriber-credit alias and no-wholesale flag;
paid forwarding is disabled. Uncertain calls retain their reservations and
stop further evaluation. Only exact reconciliation of successful physical
requests with priced stored usage releases unused capacity. A fully read
credit refusal also requires its exact failed receipt with no token usage
before its reservation is released. Unknown failures remain reserved. The ledger spans
fresh databases, peer isolates and launcher invocations. A stale lock or
outstanding reservation requires reconciliation before another launch.

The existing `eval:mail-replay` reports all Run-scoped AI usage, including
extraction and audit, with raw token/cache counts, duration and unknown prices.
Known cost subtotals are not complete costs when calls are unpriced. Version 2 synthetic
replays fail on disposition, total, line-cost or supported-link disagreements;
free-form line names and unresolved wording remain review differences. Re-capture
baselines using this all-Run-feature cost scope before comparing performance. Private replay
disagreements remain report-only evidence for member grading. Scripted replay
proves execution plumbing, not model quality or speed.

- Pi's instructions are skill Markdown (`mail-import.md`, `extraction.md`, the
  settlement rules) selected in `import-run-workflows.ts`; editing them changes
  production behavior.
- `server/domains/purchase-agent/service/signals.ts` bytes are matched by the workerd scripted
  model; keep them stable.
- Pi mounts MCP tools from the same compiled catalog the MCP server lists
  (`server/mcp/agent-tool-catalog.ts`); renaming a tool or action changes both.
