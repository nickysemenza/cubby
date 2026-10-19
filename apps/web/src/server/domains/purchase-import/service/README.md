# Purchase import: Mail import, member imports and Burn-down

[ADR 0010](../../../../../../../docs/adr/0010-mail-import-unattended-burn-down-interactive.md)
splits purchase work in two (vocabulary: [terminology](../../../../../../../docs/guide/terminology.md#purchase-research)):

- **Mail import** (unattended): Gmail discovery classifies and retains order
  Email, and a Pi agent turns it into Purchases, Expenses, Product resolutions
  and Email links. It reads only Email; there is no browser and no web search.
- **Burn-down** (interactive): a member's Claude or Codex session works the
  Research queue (the `research-queue` saved views over existing data-quality
  gaps) with its own browser, writing through ordinary MCP writes that carry
  Sources (`entity-kernel/repo/entity-source.ts`).

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
   A member's **Reclassify** (`gmail/reclassify.ts`, MCP `mail.reclassify`)
   reruns these stages, including the relevance model, for up to 200 selected
   Emails through the same ingest path in its `reclassify` mode: the result is
   history, it replaces Relevance only without dropping retained content or an
   import, and it never overrides a member resolution (ADR 0011).
   Each relevance rerun stores a versioned publication-receipt checkpoint in
   `Run.progress` before work, after every reached Email, and with the deferred
   tail on completion. The frozen
   selection and checksums remain in `Run.input`. `imports_read.run_status`
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
   `PURCHASE_AGENT_QUEUE` after commit (`dispatch.ts`). Each paid call checks
   the Run is still executable and draws from the household AI budget
   (`run/service/execution-transport.ts`, `server/ai/budget.ts`).
3. **Pi** (`agent-host.ts`, `server/domains/purchase-agent/`) runs on the generic agent
   tools (`claim_next_import_work`, `report_agent_progress`,
   `stop_import_run_for_review`) plus the MCP actions its manifest mounts
   (`packages/schemas/src/import-run-agent.ts`), called in process through the
   MCP handler with a run-bound delegation (`agent-services.ts`
   `mcpFetch`). Instructions: `.agents/skills/purchase-import/references/mail-import.md`
   via `server/domains/purchase-agent/service/import-run-workflows.ts`.
   A Mail import claim (`operations/mail-import-claim.ts`) returns the
   claimed Email's compact read (`readMail`, bounded by `fitMailRead`). Before
   claiming, it settles leading roster Emails a Mail import rule decides
   (`service/mail-import-rule.ts`, revision `MAIL_IMPORT_RULE_REVISION`)
   through `mail.resolve`'s own writer, with no model call: a shipped,
   delivered or duplicate confirmation notice (subject phrase; no refund,
   cancellation, return or failure wording, including item cancellations in
   the body) whose complete compact read's printed order identifier
   (`purchase_cues`) names exactly one live Purchase of the sender-proof
   Vendor (`senderProofVendor`) on the Email owner's own account there, with
   no retained attachment bytes and an accepted import source (an unitemized
   Purchase goes to the coordinator, which can itemize it from the notice),
   links as that event (proposer `heuristic`, Assessment producer `rule`); an
   Email the classifier confidently called unrelated (stage `rule`,
   `decision` or `model`, in a Run the member did not select, from a sender
   that proves no Vendor) resolves
   `unrelated` (its resolution observation carries the revision, so its
   `email_relevance` Assessment's producer is that rule). Everything else,
   an incomplete or paged compact read, and any refusal `mail.resolve`
   returns, goes to the coordinator. A rule
   link skips the `mail-attribution` judgment: on the owner's own account it
   cannot change what the link writes.
4. **Writes**: `imports_read.mail` reads a retained Email (`mail-tool.ts`
   `readMail`); `purchase_import.prepare/commit` (`import-orders.ts`) import an
   order through `writer.ts`, and a mail-sourced commit (message or
   attachment) links and settles the Email as the Purchase's confirmation,
   and a commit that creates Products starts a `scheduled` category
   suggestion sweep for them when AI refresh is active
   (`import-category-sweep.ts`);
   `mail.resolve` records a lifecycle link, an unresolved gap or an unrelated
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
   roster's 50 Emails and the Run's execution claims. A Run the member did not
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
5. **Settlement**: Pi's settled submission reconciles the Run
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
| Sources                                    | `server/entity-kernel/repo/entity-source.ts`                           |

## Hidden dependencies

- Pi's instructions are skill Markdown (`mail-import.md`, `extraction.md`, the
  settlement rules) selected in `import-run-workflows.ts`; editing them changes
  production behavior.
- `server/domains/purchase-agent/service/signals.ts` bytes are matched by the workerd scripted
  model; keep them stable.
- Pi mounts MCP tools from the same compiled catalog the MCP server lists
  (`server/mcp/agent-tool-catalog.ts`); renaming a tool or action changes both.
