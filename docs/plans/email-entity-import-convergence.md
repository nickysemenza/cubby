# Email entity and import convergence

Status: Core implementation and subsequent fixes shipped through merged PRs
[#1866](https://github.com/nickysemenza/cubby/pull/1866),
[#1867](https://github.com/nickysemenza/cubby/pull/1867),
[#1868](https://github.com/nickysemenza/cubby/pull/1868),
[#1869](https://github.com/nickysemenza/cubby/pull/1869) and
[#1870](https://github.com/nickysemenza/cubby/pull/1870).
The replacement Email, classification-observation and source-order-observation
tables are live; retired Run target/fact/candidate tables are absent. Do not
replay the completed cutover or reconstruct unknown historical associations.
Burn-down and acceptance remain in progress.

## Current acceptance work

- Reconcile the evidence-backed financial and findings worklist through public
  writers, preserving signed refunds, claims, party cents and stock. A healthy
  detector count does not establish source acceptance of an older audit.
- Finish the remaining packaging-brand evidence gaps in the approved Product
  scope. Retailer identity does not prove packet manufacturer; retain uncertain
  facts explicitly rather than treating complete declared fields as acceptance.
- Reconcile open findings from authentic retained sources. A legacy finding
  without its original message roster cannot be dismissed from sender identity
  or today's Expenses. Receiving remains a member decision.
- Measure rule-driven abstention separately from model uncertainty, including
  oversized and multipart evidence. Independent grades and exact message
  availability are required before making accuracy claims; tuning confidence
  alone cannot repair an incomplete decision view.
- Verify actual continuous new-mail processing, ownership, classification-only
  routing, retained history and bounded budget accounting. Model estimates are
  distinct from provider billing and independently measured accuracy.
- Present historical restart readiness before requesting a new applicable
  authorization. Historical coverage and Pi import remain separate gates.

The current member-directed closeout excludes CI and installed-client
acceptance. This scope does not declare those checks passed or replace the
repository's general validation policy.

## Verified delivery

- [PR #1888](https://github.com/nickysemenza/cubby/pull/1888) delivered the
  image-provenance writer and its merged supporting corrections: bounded HTML
  evidence, historical prepared-candidate reads, complete provider account masks
  and the MCP member-action alias. Public writer/readback checks establish
  persistence; retained image bytes and associations survive provenance updates.
- [PR #1899](https://github.com/nickysemenza/cubby/pull/1899) retains distinct
  readable HTML beside plain text, with bounded links, image descriptions and
  structured data. Incomplete negative verdicts abstain; originals remain intact.
  Its validation fixes passed the full local `pnpm check:all` command.
- [PR #1898](https://github.com/nickysemenza/cubby/pull/1898) added export
  membership, and [PR #1900](https://github.com/nickysemenza/cubby/pull/1900)
  added reviewed repeated-mask legacy membership. Both are deployed and public
  replay/readback has verified coverage without new StatementRows or changes to
  money, stock, claims, identifiers, allocations or provider evidence.
  `reviewedLegacyAccountDescriptor` requires a positionless retained identity,
  one extra identical complete trailing mask, and no competing stored or incoming
  canonical row. This never equates accounts or promotes unknown occurrences.
- The source-specific acceptance worklist remains private. Detector counts and
  completion of a terminal Run do not establish acceptance of historical source
  bindings, classification accuracy, continuous processing or a paid restart.

The behavior decisions live in [ADR 0011](../adr/0011-email-as-a-first-class-entity.md)
and [ADR 0012](../adr/0012-import-convergence-through-burn-down.md).
The README's final diagram depicts the target. This file owns execution order,
regression boundaries and delivery evidence; retire it when the work is complete.

## Original ownership and implementation sequence

The sequence below records the implementation brief; current work follows the
acceptance list above rather than restarting these completed stages.

Root keeps the current main session and owns architecture, schema/binding spine,
migrations, generation, integration, broad validation and production actions.
All implementation agents use the same workstation and checkout; only root
accesses production. T3 delegates use explicit Codex models/efforts. Shared files
stay with root or receive a sequential handoff; independent lanes never overlap.

1. Root inventories persisted shapes, all readers, client contracts and incoming
   edges; defines the authorized single-migration breaking cutover and writes failing
   persisted-state regressions before changing each guarded behavior. Resolve
   runtime facts from the checkout rather than copying historical observations.
   Complete when each deletion has a reader replacement, data disposition and
   named regression, and migration ownership is exclusive.
   Preserve the member-requested service states. Lock retired copy/drop sources
   inside the migration, verify SQL preservation, then merge/deploy. Promote
   historical evidence only after matching code replaces old in-flight work.
2. Root changes the manifest/storage/contracts and generates the shared spine.
   Preserve identity and shortcode mappings over the union of existing mail rows,
   accepted source families, dismissals, promoted images and operation outcomes.
   Complete when generated contracts expose the target shapes and synthetic
   migrated data preserves ownership, money and replay behavior.
3. A `gpt-6.1-sol` / high lane owns Gmail classification/discovery/retention and
   manual admission under `apps/web/src/server/purchase-import/gmail/`, with
   sequential handoff for mail Run admission/settlement files. Root owns its
   schema and shared contracts. Complete when retry/continuation boundaries
   enforce classification-only mode, per-Email import grants do not open a
   global gate, metadata repair works, and retention tests pass.
4. A separate `gpt-6.1-sol` / high lane owns import writer/reconciliation files
   and their focused regressions under `purchase-import/`, excluding the Gmail
   lane and root-owned README/contracts. Complete when equivalent evidence adds
   no spend, conflicting observations prepare guarded resolutions, and changed
   financial evidence stays unaccepted until explicit commit.
5. A sequential `gpt-6.1-sol` / high lane owns photo-specific persisted state and
   callers under `photo-import-run/` and photo repositories. Root supplies schema,
   entity lifecycle and Run current-state contracts. Complete when capture order,
   membership, processing, skips, duplicate-file reuse, approval handoff and
   interrupted-commit replay survive without the generic target/progress tables.
6. Use `gpt-6-luna` / high for bounded client/docs deletion units with explicit
   file lists after contracts stabilize; use Sol/high for complex client behavior.
   Web, native and generic adapters receive disjoint file ownership. Root owns
   generators and shared manifests. Complete when every client consumes the new
   shapes, obsolete routes/viewers/fields disappear and compatibility is 2.20.0.
7. Root integrates, reviews diffs, executes final gates and obtains independent
   review. Each lane returns commands, result, duration, relevant failures and
   limits; root reuses unchanged focused results. Complete when the exact final
   head has all required local and GitHub evidence and reviewer findings resolved.

Do not change `apps/web/src/server/repo/spending-classification-review.ts` or the
MCP HTTP handler. Update operations, declarations, bindings and generated clients
at their owning boundaries instead. Load web/native/design instructions and
owning skills when their implementation lanes begin.

## Implementation obligations from Astra

- Classification-only is persisted execution policy, enforced on classification,
  admission, retries and continuation. Retained content does not imply Pi
  eligibility. Jev/Clef have no dollar ceiling; keep bounded execution/retries and
  accounting. Pi/Luna/Sol keep their own authorization. Explicit per-Email launch
  works without enabling automatic backfill or readmitting an existing backlog.
- One Email identity/header owner has optional content. Historical missing
  headers need Gmail repair; unavailable originals remain explicit unknowns.
  Content clearing preserves source/checksum/link decisions. Accepted links
  conflict with automatic unrelated predictions. Promoted images retain their
  independent ownership. Seven-day member-search expiry clears only unaccepted
  content caches, with metadata/history/disposition preserved.
- One association resolver backs hydration, filters, counts and related-record
  views. Include canonical import families and attachment-backed sources;
  distinguish accepted associations, lifecycle links and dismissals. Same-thread
  relations are mailbox-scoped context, never proof of Purchase association.
- Separate new source observations from accepted extractions and financial
  evidence. Transactionally recheck resolution fingerprints covering lines,
  identities, payments and allocations. Consolidate guarded photo-to-item-Expense
  linkage into this shared reconciliation contract and expose candidate evidence
  through MCP. Photo readers expose member-owned known accepted-source selectors
  (`sourceOrderId`, `lineIndex`); unknown historical extractions expose none.
  Standalone `attach_only` prepare/review/commit replaces direct Expense linking,
  preserving existing money and inventory on commit and replay. Statement charges
  remain settlement evidence.
- Replace mail membership/outcomes as well as typed photo membership/outcomes
  before dropping `RunTarget`. `Run.progress` already holds discovery checkpoints;
  replacing `RunProgress` also needs phase, heartbeat, approval state and
  attempt/sequence fencing. Keep `RunOperation` and source ownership ledgers.
  Account for every reader, incoming edge and historical row before deletion.
  Immutable `target_outcome` receipts preserve the original UUID and tombstone;
  deletion and merge never repoint their historical subjects or treat them as
  live retaining or orphan-blocking relationships.
- Predictions and reviewed labels are distinct immutable facts. Preserve decision
  checksum, model/version, stage and usage attribution before resolution. Fresh
  evaluations are new measurements, not reconstructed historical predictions.
  Built-in member-only evaluations freeze the latest non-resolution prediction
  per owned Email and uniformly sample every stage/class/model stratum, including
  unrelated messages, with known population/sample counts and probabilities.
  Blind public reads reveal no prediction metadata. Immutable grades require
  proof of the frozen checksum for valid labels and preserve unavailable reviews
  without changing routing. Reports provide inverse-probability weighted pipeline
  and exact-known Jev/Clef model-only matrices and conditional determinate
  precision/recall, with ambiguity, unavailable originals, historical metadata,
  missing/changed ownership, ungraded counts and denominator warnings. The generic
  Email Review view reads the latest member-owned evaluation on an explicit
  member-wide basis, provides the 200-Email sample command, and distinguishes
  current from stale checksum-bound independent labels without changing routing.
  Follow the owning [accuracy review workflow](../../.claude/skills/purchase-import/SKILL.md#review-email-accuracy)
  for blind MCP reads, member Gmail review, grades and measured Burn-down coverage.
- Jev/Clef extraction chooses evidence-bound parsed candidates. Validate the
  resulting order as a whole: currency, dates, quantity, signed adjustments,
  totals and identity. Measure correctness, abstention, retries and workflow cost.
  Estimates carry their basis, uncertainty, transport and unknown attribution.
- Wardrobe uses existing apparel Products and the owner-scoped Wardrobe
  collection. Inventory is optional until owner/location resolve. Reused Products
  need follow-up source-backed transcription. New label revisions reopen a
  generic evidence-review check; relevant new evidence also invalidates stale
  negative-knowledge exceptions. Size/color remain in titles; raw tag facts remain
  in notes. Retain Sources after patches; do not treat nonempty notes as proof of
  completed review. `product_label_review` belongs to the derived Research queue:
  read the Product's readonly `labelEvidenceRevision`, review its live label
  images and exact variant, then patch `labelReviewedRevision` to that same
  revision with the facts and verbatim Sources. The stored stamp is nullable;
  stale stamps refuse the complete patch. Canonical Image identity/content
  evidence includes unknown hashes and survives interrupted Run work. The
  [photo import skill](../../.claude/skills/photo-inventory-import/SKILL.md)
  owns the read/review/stamp workflow.
- Delete obsolete MCP instructions advertising retired browser research, alongside
  VendorAccount browser fields/status variants and the dead evidence route/Swift
  viewer. Preserve the distinct Mailbox/Run authentication states. Field Sources,
  import source ownership and execution replay retain their separate invariants.

## Regression and acceptance boundaries

Write relevant failing regressions before implementation. Extend the existing
arrival-order coverage with independent receipt evidence; cover equivalent and
conflicting itemizations, orderless receipts, photo-first and purchase-first
variants, unlinked item Expenses, unknown money and interrupted commit replay.
Verify source ownership, quantities, money and provenance through persisted state.

Additional boundaries: classification-only retries and continuations; explicit
single-Email admission; immutable predictions after member resolution; Gmail
repair/retrieval failure; cache expiry vs independent Image ownership; dismissal
and thread-only linked filters; stale phase/heartbeat callbacks; label review on
reused Products and reopening after new evidence. Preserve named regressions
before deleting their old assertions.

Small automated Tester Army journeys cover Email review/manual launch,
reconciliation findings/resolution and photo/wardrobe label-review handoff. Their
outcomes are confirmed by readback. Remove the universal sanitized-artifact
mandate while keeping useful existing reports and all repository privacy rules.
Update the owning validation docs: client verification is automated only, with
Apple host tests, simulator build, TestFlight build and server version-gate tests;
manual device verification is never a requirement.

Follow [agent validation](../agents/validation.md) for focused behavioral checks
and delivery, and [model routing](../agents/model-routing.md) for independent
review. Reuse unchanged successful checks and read failure summaries rather
than rerunning a tier. Link every worked PR to T3; report unrun checks and
distinguish merge state from production readback.

## Historical cutover order and stop conditions

This section records the completed cutover sequence. It is not authorization
to repeat production migrations, recovery or historical discovery. Remaining
work follows the current acceptance scope above and current member gates.

Root is the exclusive migration owner. The member authorizes a breaking cutover
but explicitly requests leaving production services running. Do not toggle
maintenance, pause queues or Workflows, or change existing paused states. Verify
current activity and backlog, but do not treat observed idleness as a concurrency
barrier. Old requests may fail on contracted tables/columns until deployment.

1. After exact-head checks pass, capture financial and provenance snapshots and
   apply `0035_email_import_cutover` before merge. Its transaction-held exclusive
   locks precede the first read of retired Run tables, excluding committed updates
   during copy/drop. Lock and statement timeouts refuse and roll back rather than
   bypass contention. Read back SQL preservation, identity mappings, source history,
   photo outcomes and the catalog before merge; verify rollback/bookkeeping after
   any migration failure. Production schema changes remain serialized.
2. Merge immediately after migration readbacks and verify the matching server
   deployment. After old in-flight work finishes, run the canonical historical
   accepted-order TypeScript transform, investigate refusals, verify financial/stock
   preservation and accepted-reference consistency, and confirm a second apply
   promotes zero. Promotion must follow deployment: old import writers can update
   surviving associations without maintaining the new observation reference.
   Verify automated native/TestFlight delivery and the compatibility gate. There
   is no second migration; normal use resumes after deployment verification.
3. Dispatch recovery-only `maintenance.recover`, not the catch-up action that also
   queues purchase discovery. Use a one-time cutoff covering newly settled Runs
   while preserving oldest-first batches, destroy/confirm and failure isolation.
   Repeat bounded recovery until read-only inspection finds no settled agent Run
   with an agent session and missing retirement timestamp; report any blocker.
4. Reconcile the stuck discovery Run to failed, then resume Gmail only in
   classification-only backfill mode. Leave authentication-paused mailboxes
   unchanged and report them. Preserve the existing stuck Email backlog.
5. Grade roughly 200 decisions through the Claude Gmail connector and built-in
   Email review, including predicted-unrelated messages. Report pipeline and
   model-only precision/recall, confusion matrices, sample denominators,
   unavailable originals and costs. Use sanitized examples outside private app
   data. Stop for the member's decision before automatic Pi/Luna/Sol backfill.

## Housekeeping and completion report

Outside the PR, verify merged/empty state and remove the specified stale Cubby
worktrees: caller-driven-research, caller-driven-contract, coordinator-disposal
(PR #1851 is merged), and empty mail-classification. Remove only the specified
stale `cubby-db-1` Docker container after verifying it belongs to the gone worktree.
Leave `~/.cubby-private` alone.

The final report includes linked PRs and exact reviewed/tested revisions, deploy
and automated client verification, deleted files/tables and retained-table reasons,
net production/generated/test line changes separately, production readbacks,
coordinator disposal completion count, measured accuracy/cost, remaining gaps and
every material check that did not run. Confirm T3 PR registration and unwatch
before handoff.
