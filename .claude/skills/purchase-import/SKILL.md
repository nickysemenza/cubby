---
name: purchase-import
description: Support Cubby purchase imports when learning a vendor, ingesting a vendor export, enriching unresolved products, or reconciling financial settlement.
---

# Purchase-import support

Flue, Claude, and Codex use this same workflow. Flue owns routine browser,
email, receipt, retry, audit, and lifecycle orchestration; a human agent may
continue the same work for unusual evidence. Source-backed orders always pass
through Cubby's prepare/commit writer rather than generic entity mutation.

## Invariants

- `SUM(Expense.cost)` is the only spend ledger. A Purchase describes an order;
  a FinancialTransaction is settlement evidence.
- Inventory never auto-increments. An `arrived` finding asks a human to receive.
- Use source totals and itemization exactly as printed. Never scale lines to
  `statedTotal`, infer tax, or fabricate a transaction to close a gap.
- Vendor-account imports are member-owned. The authenticated user must own the
  named VendorAccount through `LedgerParty.userId`.
- Public identifiers are shortcodes. Never expose private UUIDs to the user.
- A source row is replay-safe only when its kind, external key, and checksum are
  stable. If the same source key changes, stop on the conflict.

## Vendor export

1. Resolve the member-owned VendorAccount.
2. Collect one preparation payload per order: stable source identity, header, printed
   grand total and currency, item and adjustment lines, shipment state,
   transaction evidence, and finalized document image shortcodes.
3. Call `prepare_purchase_import` in batches of at most 50 orders. Preserve its
   preparation revision and stable line ids.
4. Resolve every principal line. Prefer exact retailer SKU, ASIN, UPC/GTIN, or
   manufacturer model; then inspect Product aliases, names, and details. Before
   choosing `new`, check inventory-first Products (`dataGap: product_unpurchased`,
   same category/owner) — see the either-side-first contract in
   [product identity](../product-enrichment/references/product-identity.md).
   An exact identifier match resolves the line straight to that Product
   (`existingId`); a descriptive-only match does not — choose `new` for this
   line's own vendor Product instead, then call `propose_product_match` with
   the candidate pair and evidence for human review. Otherwise choose an
   existing Product shortcode, explicitly choose `new`, or leave the line
   `unresolved`. Never create a Product merely because search was
   inconclusive, and never claim a descriptive-only candidate directly.
5. Call `commit_purchase_import` with the preparation revision and every line
   resolution. Do not use generic entity creation for imported Products or
   Expenses.
6. Inspect every ordered result. `created`, `updated`, and `replayed` are
   terminal; `conflict` requires review.
7. Report every conflict or open finding; resolve it through the Problems UI.

For a Flue run, call `claim_next_import_work` before selecting an evidence
path and after each committed item. Account-sync work is a `cursor_walk`
(capture the order-history page; importing it records an `order_list` of
orders with `nextPageUrl`, or `null` once the page predates the account
cursor), then one `order` at a time (capture and import its detail page),
then hunts and enrichment; `finish_import_run` refuses while a listed order
is still pending. A `receipt_evidence` item must go through
`extract_receipt_evidence`, whose immutable source/checksum/extraction payload
is passed unchanged to `prepare_purchase_import`; it is not a separate writer.
For browser evidence, continue every selected order or hunt before calling
`finish_import_run`; that server transition refuses pending hunts and performs
the required auditor batches. Persist only same-domain observations with
`save_navigation_hints`, record a proven vendor-history boundary with
`mark_history_expired`, and use `stop_import_run_for_review` when evidence is
ambiguous or unreadable. Every turn ends in one of: a pending browser command,
`awaiting_approval`, `finish_import_run`, or a review stop (a progress report
with phase `review` stops the run exactly as `stop_import_run_for_review`
does); a run left without any of these is moved to review by the server.
These run-lifecycle tools are not substitutes for the prepare/commit writer.

An interrupted mutation is recovered through
`import_operation_status` with its original operation id. Repeating
the source payload is replay, not a way to revise a reviewed decision; a
correction creates a linked successor run and new decision revision.

## Learn a vendor

Create or update the Vendor deliberately, then configure:

- `orderEvidence`: `online_account`, `receipt_only`, or `not_expected`;
- `browserDomains` and `orderUrlTemplate` for online accounts;
- `orderEmailSenders` for Gmail discovery;
- `returnWindowDays` only when the policy is known.

Create one VendorAccount for each member login. Confirm its ownership in the UI.
Use Sync now while the Mac app and chosen browser are open. Treat cached
navigation hints as advisory observations within `browserDomains`.

For every exact merchant descriptor observed on that member's statement, call
`confirm_purchase_merchant_vendor` after the human/vendor mapping is known.
Charge-driven hunts leave unmapped descriptors for review.

## Settlement

Load [financial-settlement.md](references/financial-settlement.md). Match literal
posted charges or refunds to Purchases; one transaction may allocate across
several Purchases and one order may have several shipment charges. Do not create
synthetic transactions. If evidence is incomplete, leave settlement unresolved.
Monarch rows prove settlement, not itemization or exact Product identity. Use
email/order lines for items and prefer matching existing photo-created Products
when variant evidence agrees. Keep historical Expense attribution separate from
current inventory ownership. Reconciliation never receives that inventory again.

## Enrichment fallback

Run the `product-enrichment` skill for unresolved Products after an import.
Prefer stable vendor identity such as SKU, ASIN, UPC, or model. Leave ambiguous
identity as a finding and preserve human-linked Products. An inventory-photo
handoff matches an existing Product; it does not turn an unresolved photo into
a new purchase-import Product or inventory.

## Agent authority

Reads are available through Cubby's ordinary MCP catalog. The bounded
prepare/commit workflow may write without a separate approval. Generic creates,
updates, deletes, merges, and inventory receiving pause for an exact typed
approval; prose in a prompt is never approval. Receiving remains a human
decision and inventory never changes merely because an order arrived.

## Completion report

Report source coverage by outcome, touched Purchases, settlement matches,
enrichment performed, and every open finding. State that inventory was not
received.
