---
name: purchase-import
description: Reconcile vendor orders, receipts, and financial statements against Cubby's Expenses, Purchases, FinancialAccounts, and FinancialTransactions. Use when the user supplies order exports, receipts, statement rows, or vendor account dumps and wants source coverage checked, rows deduplicated, spend lines matched, receipt lines selectively promoted to Products, settlement evidence recorded, refunds handled, or financial reconciliation verified.
---

# Import vendor purchases

Reconcile source evidence into Cubby without inventing identity, spend, or
settlement. An explicit request to ingest authorizes unambiguous matched
creates and updates plus high-confidence Product promotion. Pause for ambiguous
identity or cost allocation, destructive cleanup, and inventory receiving.

## Read this model first

```text
Expense → Purchase ← FinancialTransaction → FinancialAccount
          ↑
        Vendor
```

- `Expense.cost` is the only spend ledger. Never derive spend from a Purchase or
  Financial Transaction.
- `Expense.lineKind` records the receipt role: `principal` for merchandise or a
  service, otherwise `tax`, `shipping`, `discount`, `fee`, `tip`, or
  `other_adjustment`. Every kind remains spend in `SUM(Expense.cost)`. Pass
  `lineKind` explicitly on every adjustment row. Inference is a narrow fallback,
  not the mechanism: it fires only for an adjustment-like name on a Product-less
  Expense and never re-runs on rename. Read the kind back off the write response
  instead of assuming it.
  **`lineKind` is a documented, optional field on `create_expense(s)`,
  `update_expense(s)`, and `split_expense` (per part)** — all three store it
  and echo it back. `splitExpenseInput.parts` carries an optional `lineKind`,
  and `splitExpense` resolves `part.lineKind ?? infer(...)`, so an explicit
  kind on a part wins over inference: splitting a receipt with an `Outside
  Delivery` part typed `shipping` stores `shipping`, even though that name
  does not match the inference regex and would otherwise land as `principal`.
  Do not conclude that typed rows are unreachable and fall back to allocating
  tax across merchandise; that is the superseded pattern that older Golden
  State Lumber and Bay Metals rows still show.
- A `Purchase` is one vendor order, receipt, or deliberately separate purchase
  event. `statedTotal` is the literal vendor-printed amount, never a rollup.
- A `FinancialTransaction` is settlement evidence: a charge, refund,
  installment, or split tender. Matching paperwork or Expense totals does not
  prove payment.
- Inventory is separate. Creating a Product or linking an Expense never
  receives it into inventory; receiving requires explicit user authorization.
- Public IDs are shortcodes (`EXP-`, `PUR-`, `PRD-`, `FAC-`, `FTX-`), never
  UUIDs.

## Load references only when needed

- Source coverage, match ranking, duplicate prevention, and generic batch
  failure handling: [matching-and-duplicates.md](references/matching-and-duplicates.md).
- Statements, Accounts, Financial Transactions, Monarch preview, and refunds:
  [financial-settlement.md](references/financial-settlement.md).
- Attachments, primary documents, return evidence, and Purchase paperwork:
  [documents-and-returns.md](references/documents-and-returns.md).
- Product promotion, identity, exact SKUs, cost basis, and receiving:
  [product-promotion-and-receiving.md](references/product-promotion-and-receiving.md).
- Source-specific quirks and historic examples: [vendor-case-notes.md](references/vendor-case-notes.md).

## Default workflow

1. Inspect the source's coverage before making absence-based claims. Record date
   range, record count, vendor, source type, whether prices are unit or extended,
   and whether it is vendor paperwork or settlement evidence.
2. Resolve the Vendor, then start the completeness audit with
   `list_purchases({dataStatus:"needs_data",vendorId,dateFrom,dateTo})`. Scope
   `list_expenses`, other `list_purchases` reads, and
   `list_financial_transactions` to the same vendor/evidence window.
3. Run `match_expenses` before proposing new Expense rows. It ranks candidates;
   it never verifies or writes. Read candidate descriptions, vendor, order ID,
   date, and amount rather than accepting a score.
4. Present a decision table separating confirmed writes, automatic
   high-confidence Product promotions, ambiguous Product candidates, ambiguous
   matches, conflicts, and unsupported rows. An explicit ingest request
   approves confirmed writes and automatic promotions across technical batch
   boundaries. Obtain a separate decision for every other category; never
   silently omit an eligible Product candidate.
5. Execute homogeneous work with `create_purchases`, `update_purchases`,
   `create_expenses`, `update_expenses`, `create_products`, `update_products`,
   or `create_financial_transactions`. Batches contain at most 50 items and are
   best-effort: inspect each ordered result, retry only failed items, and do not
   treat partial success as complete. Serialize dependent Purchase/Expense
   mutations and re-read their rows after each structural or destructive write.
6. Re-read touched Purchases and reconcile evidence. Never alter Expenses merely
   to make a reconciliation label look clean.
7. Report source-row coverage (matched, created, updated, skipped, conflicted,
   unresolved), stage/denominator progress, and counts for touched Purchases,
   Expenses, Financial Transactions, documents, Products, and receiving actions.

## Purchase and Expense rules

- Create or update `Expense` for money. Use `Purchase` only for order/receipt
  identity, vendor documents, notes, date, order ID, and stated total.
- `create_expense` and `update_expense` may resolve a vendor name and order ID,
  but use an existing `purchaseId` for several rows belonging to one order-less
  Purchase. Do not repeatedly rewrite vendor/order fields on an order-less row.
- Make a new Vendor deliberately when its identity should include website or
  notes. Reuse the roster's exact spelling; do not mint a near duplicate.
- Use `split_expense` for a real aggregate Expense that needs per-product cost
  basis. Use `link_expenses_to_purchase` for several existing Expenses on one
  Purchase, and `merge_purchases` only after explicit approval.
- Reconcile every proposed split against the vendor's own stated order total
  before writing it, and refuse the order when it does not agree. `split_expense`
  does not validate that parts sum to anything, so this assertion is the only
  thing standing between a bad source row and the ledger. It is what catches a
  cancelled line still present in an export, a unit price masquerading as an
  extended one, and a tax-inclusive export column. Report refusals; never widen
  the tolerance to make an order pass.
- Never rewrite the `productId` of an already-linked Expense during a bulk link
  or split pass. Select work by what is unlinked, not by comparing counts, and
  route a partially-linked Purchase to review — its existing links usually encode
  a human decision that a bulk matcher will silently overwrite.
- For duplicate cleanup, call `preview_entity_operation`, delete only the bogus
  Expenses, re-read to verify the Purchase is empty, then use
  `delete_empty_purchases`. Deleting a Purchase never removes spend; do not use
  it while Expenses or Financial Transactions remain.
- Before replacing a human-entered aggregate Expense with source-derived detail,
  snapshot its title, date, `costType`, trade, project, notes, URL, and future
  status. Write the exact meaningful title to `Purchase.displayLabel`; store only
  the title text because the UI adds the order ID and parentheses. Do not copy it
  onto every detailed line or overwrite a different nonblank display label.
- Preserve the snapshot's classification and context on every split part unless
  the source or user explicitly supports a correction. A promoted Product's
  category is not evidence for changing ledger `costType`, trade, or project.
  Re-read the Purchase and all replacement Expenses after the split and compare
  them with the snapshot before continuing.
- Keep trustworthy coarse Expenses unlinked rather than inventing a line-level
  allocation. A Product link is a claim about that Product's cost basis.
- Create a typed, productless adjustment Expense only when the source explicitly
  itemizes that exact amount. Use the evidenced kind; use `other_adjustment`
  when one stated amount combines multiple roles. Embedded or tax-inclusive
  pricing stays in the principal Expense and is never estimated or allocated.
- Never manufacture an adjustment from a tax rate, order-total difference, or
  reconciliation gap. A Product refund stays negative `principal`; separately
  evidenced refunded tax may be a negative `tax` Expense.
- Non-principal Expenses cannot link a Product or product quantity. Preserve
  `costType`, trade, and project as historical context, but do not use those
  fields to pretend an adjustment is merchandise.
- Keep `Expense.cost` as the extended line total. When a linked Product's
  receipt, PDF, or notes establish a whole-unit count, also write
  `productQuantity`; the derived per-unit price comes from cost divided by that
  quantity. Never replace the extended cost with a unit price.
- Leave `productQuantity` null when the count is unknown, and never assume one.
  For an evidenced return, keep the returned-unit count positive on the
  negative Expense; negative costs do not participate in acquisition pricing.
- Keep quantity evidence in the Purchase paperwork or existing notes and cite
  it in the approval table. Do not invent `productQuantitySource` or separate
  evidence fields.

## Product promotion rules

Automatically promote an exact, receipt-identified durable or repeatable
material when the source supplies stable identity and trustworthy cost
evidence. Do not ask for separate approval for these high-confidence lines. A
retailer SKU, ASIN, UPC, maker model, or an exact vendor-issued product name
plus distinguishing variant, size, finish, or profile is sufficient evidence;
a fuzzy or generic name is not.

- When an aggregate Expense contains exact merchandise subtotals plus separately
  stated shipping, tax, discounts, fees, or tips, split it into Product-linked
  `principal` lines and typed productless adjustment Expenses automatically.
  Preserve each explicitly stated ancillary amount as its own row; do not spread
  it across merchandise. Ask before proceeding when line identity is ambiguous.
- Treat a user's standing preference to promote qualifying lines as durable
  authorization for future imports. A user may still opt out for a source or
  batch.
- Do not finish an import while Product candidates are silently deferred. Every
  candidate must be promoted, explicitly skipped, conflicted, or presented for
  a decision.

- Use the rich `create_product`/`create_products` surface in one call. Include
  category, manufacturer, maker model, tags, price/mappings, and typed external
  IDs when verified.
- Keep products with the same name but different brands separate. The SupplyHouse
  `PVBC100-075` and `429-131` examples are two Products, not two slots on one
  Product.
- `model` is maker-issued; retailer identifiers belong in `externalIds`.
- Before adding an external ID, call `find_product_external_id_collisions` with
  the exact tuple. For a removal, use `patch_product_external_ids` with the
  exact currently stored `expectedExternalId`.
- Leave heterogeneous buckets and evidence without a defensible per-product
  cost productless. Products created for a durable remain eligible for explicit
  receiving only after user approval.

## Financial settlement

For statements, parse files in the MCP client. Never send a CSV path, upload,
or raw file contents to Cubby.

1. Send normalized Monarch rows to `preview_financial_statement_import` in
   batches of at most 200.
2. Create Financial Accounts only when approved; use a truthful provisional
   Account when evidence identifies only something like `Visa ····3692`.
3. Before submitting, read each proposed row back and confirm `kind` is
   `purchase` for charges and `refund` for credits. A wrong-signed row previews
   as a clean `ready_to_create` with tying amounts, so a totals check will not
   catch it.
4. Submit only approved `ready_to_create` rows through
   `create_financial_transactions`, then backfill `sourceRefs` (plural, an
   array) with `update_financial_transactions` — the create path does not accept
   one, and the singular `sourceRef` is silently discarded.
5. Leave `already_recorded` untouched. Review `possible_existing`,
   `unresolved_account`, and `indistinguishable_duplicate` manually.
6. Read the generic batch result and then inspect the Purchase's settlement
   reconciliation. A source-reference conflict is a failed item, not permission
   to change another row.

Posted Financial Transactions without source references can leave a
`settlement_reference` data-quality gap. Preserve vendor-reported payment hints
as notes/evidence; do not infer a Financial Account from them.

## Documents and exceptions

- Attach original evidence when available; do not manufacture PDFs from email
  or text merely to satisfy completeness.
- Use final invoice/receipt first, then credit memo, order acknowledgment, and
  quote/estimate. Pasted email text is useful note-level reconciliation evidence,
  not an attached primary document.
- File a Purchase document with `attach_file` and a truthful `documentKind`.
  Use `reclassify_purchase_document` only to correct an existing attachment.
- Attach by `url`, never by base64 `data`: `data` truncates silently above a few
  KB and returns success. Verify every attachment by fetching the stored URL back
  and comparing bytes to the source. An unverified attachment is not filed — a
  corrupt one is worse than none, because it clears `primary_document` and makes
  the Purchase read as documented.
- Use `set_data_exception` and `clear_data_exception` only for source-backed
  negative knowledge after checking available sources. They are not substitutes
  for research. Two constraints worth knowing: `primary_document` rejects
  `not_applicable` (use `not_issued` — a return or a deposit against an unnumbered
  contract genuinely had no invoice issued), and **an exception goes `stale` when
  the entity is written again afterwards**, which re-opens the gap. Set exceptions
  last, and re-read the Purchase after any later write to confirm they are still
  `active`.

## Final checklist

- Every source row is accounted for as matched, created, updated, skipped,
  conflicted, or unresolved.
- Every new/changed Expense has truthful cost, date, Purchase/Vendor identity,
  and Product link only when its cost basis is defensible.
- Every new Financial Transaction has truthful account, sign, status, posting
  date when posted, source reference, and Purchase link when known.
- Touched Purchase `statedTotal` remains literal paperwork; reconciliation gaps
  are explained rather than hidden.
- Meaningful human-entered aggregate titles are preserved in
  `Purchase.displayLabel` before duplicate Expenses are deleted, and replacement
  Expenses retain the original human-entered classification and context unless
  an evidenced correction is reported.
- Every eligible Product candidate was promoted, explicitly skipped,
  conflicted, or left pending with a direct user question.
- Product creation, document filing, and inventory receiving were reported as
  distinct actions. Report coverage separately for the Purchase, acknowledgment,
  final invoice/receipt, credit memo, charge, and refund, including unresolved
  gaps.
