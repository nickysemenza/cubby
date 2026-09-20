---
name: purchase-import
description: Support Cubby purchase imports when learning a vendor, ingesting a vendor export, enriching unresolved products, or reconciling financial settlement.
---

# Purchase-import support

Flue owns routine browser, email, receipt, retry, audit, and lifecycle
orchestration. Use this skill only for the human-guided branches below. Send
source-backed orders through Cubby's purchase-import writer rather than generic
entity mutation.

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
2. Collect one writer payload per order: stable source identity, header, printed
   grand total and currency, item and adjustment lines, shipment state,
   transaction evidence, and finalized document image shortcodes.
3. Call `import_vendor_orders` in batches of at most 50 orders.
4. Inspect every ordered result. `created`, `updated`, and `replayed` are
   terminal; `conflict` requires review.
5. Report every conflict or open finding; resolve it through the Problems UI.

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

## Enrichment fallback

Run the `product-enrichment` skill for unresolved Products after an import.
Prefer stable vendor identity such as SKU, ASIN, UPC, or model. Leave ambiguous
identity as a finding and preserve human-linked Products.

## Completion report

Report source coverage by outcome, touched Purchases, settlement matches,
enrichment performed, and every open finding. State that inventory was not
received.
