# Caller-driven research: Mail import stays unattended, Burn-down goes interactive

Base: `origin/main` `70915d343`, 2026-10-10. Decision record:
[ADR 0008](../adr/0008-mail-import-unattended-burn-down-interactive.md).
Vocabulary: [GLOSSARY](../../GLOSSARY.md). One big-bang PR with breaking
changes and a downtime window. Goal: substantial net code deletion. Revised after
Fable/high and Astra/high plan review (rounds 1 and 2); round-2 dispositions are
recorded in [Round-2 dispositions](#round-2-dispositions).

## Split

| Concern | Owner |
| --- | --- |
| Mail discovery: pagination, frozen-page replay, Spam/Trash exclusion, exact coverage | Server, unchanged; classification also records deciding stage (rule/Jev/model) + short reason on `MailboxMessage` |
| Mail import: Email → Purchase, Expenses, Product resolutions, Email links | Pi, Luna/Sol routing, skills, existing paid caps + known-price admission. Email only: no browser, no web |
| Product details, variants, images, unresolved lines, unmatched charges, receipt itemization | Burn-down: member Claude/Codex via Cubby MCP with its own browser |
| Photo inventory | Pi, unchanged |

Pi and Burn-down use the **same public MCP tools**. There is no private research
tool family.

## Tools both callers use

- `mail_search` (owner-authorized scoped live Gmail search; excludes Spam/Trash;
  frozen page; never advances mailbox coverage; matched messages become pending
  `MailboxMessage`s for the next Mail import — no child Runs) and `mail_read`
  (retained Email + attachments), promoted to public MCP actions.
- `purchase_import.prepare/validate/commit` — `writer.ts`, `ImportSourceClaim`
  fence prevents re-import; Email links.
- Generic `entity.create/update` (collection fields such as `externalIds` accept
  add / replace / remove-with-precondition patch items), `image.create_uploads`
  → presigned PUT → `image.attach_files` (or `url`), `propose_match`,
  `data_exception`.
- Every write accepts `sources[]`.

## Source (generic, ADR 0007 style)

`EntitySource`: entity identity, optional field path, URL, quoted text,
observedAt, selected variant, recorder (member / OAuth client / Pi), createdAt.
Declared once in the manifest for every entity; generic presentation shows a
Sources section with per-field hints. Burn-down writes are member-equivalent
(may overwrite). `AuditLog` is unchanged.

## Research queue

Saved view / thin `research.queue` read over existing manifest data-quality
checks on Purchase-linked records (`product_*`, `expense_product_resolution`,
`purchase_itemization`, `financial_transaction_*`, …), ordered by `dataQuality`
asc. "Searched, not available" = `DataException` bound to its evidence
fingerprint. Open `RunFinding`s stay in Problems. Any entity can also be targeted
directly. Home/Activity shows the queue count linking to the view.

## Receipts

Apple receipt photo for a charge creates a minimal Purchase (vendor, date,
amount, linked to the charge) with the photo as `documentKind: receipt`; it
enters the queue via `purchase_itemization`. Replaces receipt-hunt submission.

## Deletions

- Research service family: `research-tools.ts` schemas, `researchServiceFor`,
  `research-*.ts` (~12.7k LOC), `purchase-agent/tools.ts` forwarding,
  `research-support.ts` independent assessor, `purchase-validation-research.ts`,
  `research-objective-*`, `research-legacy-*`.
- Unattended enrichment launches: `product-research-run.ts`,
  `enrichment-sweep.ts`, post-commit hook, browser-sync-enable sweep,
  research-launches-research, `targeted-run.ts` dispatch.
- Mac browser bridge: `PurchaseImportDurableObject`, broker `sql-store.ts`,
  Mac OAuth/socket/agent routes, browser services/commands, 22 Swift files
  (5,871 LOC) incl. `BrowserSyncPane` and notifier, CLI `BrowserCommand`,
  `PURCHASE_IMPORT` binding.
- Account sync, charge hunts, receipt-hunt objectives and their reports/schemas;
  `run.start`, `start_sync`, `start_charge_run`, `run_launch_preview`,
  `sync_plan`, `charge_hunts` MCP actions.
- MCP `product_enrichment.commit/skip/overwrite`, `patch_external_ids`.
- Browser-only `run-service` branches, `liveProgressBlocks`, browser debug
  projections, web import Run console / targeted launch / agent connection,
  native Activity attention/execution progress for browser Runs.
- Server `web_search` / `web_read` (todo: Cloudflare web search for Mail import,
  logged-out pages).
- `research-browser-retention.ts` once nothing owns it.

Keep: Pi lifecycle shared by Mail import and photo (coordinator ack, grant
fencing, retention delivery, execution authorization), Gmail discovery,
`gmail/review.ts` + `OrderMail*` (no Email entity promotion; expose mailbox +
`messageId` + `threadId` in Purchase reports and queue context).

## Data (one preserving-where-stated production migration)

Drop: `RunFactEvidence` (after copying supported values into `EntitySource`),
`RunEvidence` + its R2 objects not referenced by an Image, `RunOperation`,
`RunTarget`, `RunOrderCandidate`, `RunProgress`, `ResearchSourceExposure`,
`ResearchRetention`, `ImportHunt`, Mac relay and Pi research DO storage.
Condition: verify photo inventory and `purchase_import` no longer read a dropped
table; otherwise keep it and report.

Keep: `Run` (thin history), `ImportSource*`, `RunFinding`, `MailboxMessage`,
`MailboxCursor`, `OrderMail*`, `ImportPrepared*` if still used, `AuditLog`.

Add: `EntitySource`; `MailboxMessage` classification stage + reason.

Downtime sequence: fence dispatch and writers → finish/transform pending
disposal → copy sources → verify historical reads → drop tables, storage and
bindings → deploy clients. Bump `APPLE_CLIENT_COMPATIBILITY_VERSION`.

## Required behavior (failing-first; persisted-state headless + one synthetic MCP/UI journey)

Reuse existing Products before creating; source-first (original Email/order
links, authenticated history) before general search; Sources accepted without
screenshots; exact purchased-variant reasoning and honest unresolved outcomes
(DataException); member/source authorization; no duplicate writes across
retry/replay (`ImportSourceClaim`, `idempotencyKey`, expected-count
preconditions); absent caller → work pending, no browser or research spend;
Gmail pagination, frozen-page replay, Email linking, exact coverage; Spam/Trash
excluded, no readable unrelated mail retained; money conservation, stock
neutrality, member photos, gallery/cover choices, identifier ownership.

## Out of scope

`repo/spending-classification-review.ts`; the MCP HTTP handler; live inference,
Gmail processing and retailer automation (paused); Seed Product → Plant
linking; paid caps unchanged.

## Round-2 dispositions

These supersede earlier sections where they conflict.

- **Replay ledger kept.** `RunOperation` stays as the one idempotency and
  paid-allowance ledger, re-keyed to `(ledgerPartyId, operationId)` with a
  nullable `runId` so members can call import writes without a Run. Browser and
  debug operation kinds are deleted. Existing allowance receipts are preserved.
- **Public import contract.** `purchase_import.prepare/validate/commit` replace
  the private `_runExecution` envelope with a public `operationId` /
  `itemOperationIds`, resolve the Vendor per order, keep the retained-source
  loader and checksum validation, and stop reading `RunTarget`. `mail_import`
  gains the `prepare`, `commit_purchase_import` and `generic_mutation`
  capabilities. `ImportPrepared*` is kept; `screenshotImageId` and the
  `browser_order` source kind are dropped.
- **Email resolution.** A public `mail` tool owns `search`, `read` and
  `resolve`. `mail.resolve` atomically records one message's disposition:
  imported (link to the committed Purchase), linked lifecycle event on an
  existing Purchase (shipped, delivered, cancelled, refunded …) without
  Expenses, unresolved with its gap, or unrelated. It writes `OrderMailEvent` +
  `OrderMailCandidateDecision`, transitions `MailboxMessage`, and is replayable
  by `operationId`. `purchase_import.commit` derives the confirmation link for a
  mail-sourced order itself. `mail.read` keeps ownership, checksum and mailbox
  eligibility checks.
- **Unrelated-mail disposal without a retention engine.** An unrelated
  disposition deletes the message's retained `OrderMail` content and
  attachment objects in the same operation; a Mail import Run's Pi storage is
  destroyed when the Run settles. `ResearchSourceExposure` and
  `ResearchRetention` are dropped after the cutover drains pending disposal.
- **Tables kept:** `Run` (fields trimmed: vendor account, retirement, attempt /
  predecessor, dispatch attempt fields), `RunTarget` (photo inventory),
  `RunOperation`, `RunProgress` (Workflow lifecycle, Gmail), `RunFinding`,
  `ImportPrepared*`, `ImportSource*`, `Mailbox*`, `OrderMail*`, `AuditLog`.
- **Tables dropped:** `RunFactEvidence` (copied into `EntitySource`),
  `RunEvidence` + its R2 objects not referenced by an Image, `RunOrderCandidate`,
  `ResearchSourceExposure`, `ResearchRetention`, `ImportHunt`, and the
  `PurchaseImportDurableObject` class storage. Individual retired Pi research
  instances are destroyed; the shared `PurchaseImportRunAgent` class stays for
  Mail import and photo.
- **Findings.** Open findings whose fix interpreter or evidence is deleted
  (`vendor_capture_profile`, `research_field_correction`,
  `validation_corrections`, `auth_required`, `expected_order_not_found`,
  `receipt_required`) are dismissed in the migration with a historical note;
  no Apply command survives without its implementation.
- **EntitySource shape.** Cross-entity child declared once (like
  `ImageSighting`): enforced `(entityKind, entityId)` identity FK, optional
  field path validated against the manifest, URL, quote, observedAt (nullable
  when unknown), selected variant, the post-write `valueFingerprint`, and the
  AuditLog actor shape (user, channel, OAuth client, run). Written in the same
  transaction as the mutation. Presentation separates sources supporting the
  current value from historical ones. Merge repoints and deduplicates; entity
  delete follows the entity's tombstone. `purchase_import` and Mail import
  synthesize Sources from the retained source identity; `sources[]` is supplied
  by callers on generic entity and image writes. The migration materializes
  supported `RunFactEvidence` rows joined to their evidence (URL, quote, variant,
  actor, observedAt when known) before dropping it.
- **Collection patching.** A manifest collection declaration names each
  collection field's identity key; `entity.update` accepts
  `{op: add|replace|remove, key, expect?}` items. Slot primary/secondary
  promotion, global uniqueness and GTIN normalization stay in the Product
  repository hook. Photo inventory moves from `patch_external_ids` in the same
  change.
- **Run surface.** Purposes `account_sync`, `purchase_validation`,
  `product_enrichment`, `mail_search` are deleted for new Runs (readable
  history keeps its value through the migration). `run.start*`,
  `run.lifecycle` retry/restart for research, `imports_read.run_status`
  browser/operation detail, `sync_plan`, `run_launch_preview`, `charge_hunts`
  go; `run_status` narrows to photo and Mail import. `captureProfile` /
  `vendorCaptureProfile` are deleted. `cubby_find` callers use
  `search.global`.
- **Receipt Purchases.** Receipt ingress sets the Purchase evidence expectation
  to `required` so `purchase_itemization` applies; the charge amount is not
  booked as Expense money until itemization (money stays `SUM(Expense.cost)`).
- **Cutover order.** One owner (the implementing agent): (1) apply additive
  migration (EntitySource, columns, RunOperation re-key, source copy, finding
  dismissals) while old code still runs; (2) merge and deploy code that no
  longer reads dropped tables; (3) drain pending disposal and destroy retired
  DO instances, recording a private manifest of R2 keys and DO identities
  outside the repository; (4) apply the contract migration dropping tables and
  delete the R2 objects; (5) read back schema and retained reads.
- **Skills.** purchase-import keeps vendor export, receipt itemization and
  settlement; product-enrichment becomes the Burn-down skill; Mail import gets
  its own Pi-facing reference.
