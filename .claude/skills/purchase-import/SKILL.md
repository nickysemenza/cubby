---
name: purchase-import
description: Support Cubby purchase imports when learning a vendor, ingesting a vendor export, enriching unresolved products, or reconciling financial settlement.
---

# Purchase-import support

For a durable account sync, purchase validation, or product enrichment run,
load [run-workflow.md](references/run-workflow.md). For receipt, browser, or saved confirmation
extraction and post-commit audit, load the respective
[extraction](references/extraction.md) and [audit](references/audit.md)
instructions. For a photographed receipt or a Gmail order event, load
[receipt extraction](references/receipt-extraction.md) or
[order mail](references/order-mail.md). The import-run agent, Codex, and Claude share these
contracts.

The import-run agent, Claude, and Codex use this same workflow. The agent owns routine browser,
email, receipt, retry, audit, and lifecycle orchestration; a human agent may
continue the same work for unusual evidence. Source-backed orders always pass
through Cubby's prepare/commit writer rather than generic entity mutation.

## Connect and converge evidence

1. In Cubby Settings, connect Google with read-only Gmail access. Search order
   mail by the Vendor website's domain, any optional known sender, order id,
   and time window. On Vendor detail, **Search Gmail now** scans a bounded page
   from the past year; **Search older email** continues when Gmail has more.
   An email event establishes lifecycle context. Use **Import order** on a saved placement confirmation to let the agent extract its itemization through Cubby’s Gmail integration and prepare/commit writer. If the confirmation lacks itemized variants, stop for review and open the retailer order detail or a receipt. Shipping and delivery notices cannot start an order import. If a retailer requests login, pause the browser run
   and let the member sign in to the Cubby-managed browser tab before resuming.
2. For a statement CSV, use `/statement-rows/import` or parse the export in the
   MCP client. Known provider columns (Monarch, Mint, Copilot, Apple Card) use
   deterministic adapters; other CSVs need a reviewed column, account, source,
   and amount-direction mapping. Keep the raw file out of prompts and the
   repository. Save normalized nonzero StatementRows in bounded batches with a
   stable file fingerprint; count zero-value rows separately. Submit transaction
   candidates to `finance_read.preview_import` and create only approved
   `ready_to_create` FinancialTransactions with an explicit kind. Repeated
   exports replay without another charge. A source row remains evidence until
   its account and transaction have been resolved.
3. Take own-item and label photos directly on iPhone/Mac or upload a
   `photo_inventory` run. The [photo-inventory-import
   skill](../photo-inventory-import/SKILL.md) proposes groups for review and
   identifies an exact Product variant. Do not turn a photo into a Purchase.
4. Stitch the three paths by stable evidence: order id and itemized line to
   Purchase, variant identifiers and visible attributes to Product, and actual
   charge/refund to Purchase settlement. Check both arrival orders: a charge
   can predate the Purchase import, or arrive later in a statement. Propose
   ambiguous allocation and Product identity separately; show evidence and
   the changes that approval would make.

The agent coordinates durable steps, browser handoffs, progress, and review stops.
Frontier AI can propose a mapping for an unfamiliar layout; a person verifies
the columns and sign before saving. Jev can rank a bounded set of ambiguous
account, transaction, or Purchase candidates using evidence. A choice is a
proposal for review, not a settlement write or an inferred transaction.
The [human journey](../../../docs/product-identity-journey.md) describes the
same outcome without prescribing an agent runtime.

## Invariants

- `SUM(Expense.cost)` is the only spend ledger. A Purchase describes an order;
  a FinancialTransaction is settlement evidence.
- Inventory never auto-increments. An `arrived` finding asks a human to receive.
- Use source totals and itemization exactly as printed. Never scale lines to
  `statedTotal`, infer tax, or fabricate a transaction to close a gap.
- Unknown facts stay unknown. A missing cost, date, quantity, or order id is
  recorded as absent, never as zero or a guessed value.
- Vendor-account imports are member-owned. The authenticated user must own the
  named VendorAccount through `LedgerParty.userId`.
- Public identifiers are shortcodes. Never expose private UUIDs to the user.
- A source row is replay-safe only when its kind, external key, and checksum are
  stable. If the same source key changes, stop on the conflict.
- A try-before-you-buy order is trial custody, not item ownership or a paid
  purchase. Stop for review until final keep/charge evidence identifies the
  retained lines; its initial displayed total cannot be committed as spend.
  A final charge for retained items does not make the order page's returned
  items purchased.

## Vendor export

1. Resolve the member-owned VendorAccount.
2. Collect one preparation payload per order: stable source identity, header, printed
   grand total and currency, item and adjustment lines, shipment state,
   transaction evidence, and finalized document image shortcodes.
   De-duplicate saved snapshots by stable order id. A generic mail subject may
   omit the brand and variant; search sender, order id, and time window, then
   inspect the order page for itemization.
3. Call `purchase_import.prepare` in batches of at most 50 orders. Preserve its
   preparation revision and stable line ids.
4. Resolve every principal line. Prefer exact-variant identifiers: a
   per-variant retailer SKU, ASIN, UPC/GTIN, or exact manufacturer part number.
   A style, family, or model number shared by sizes or colors only ranks
   candidates. Then inspect Product aliases, names, and details. Before
   choosing `new`, check inventory-first Products (`dataGap: product_unpurchased`,
   same category/owner) — see the either-side-first contract in
   [product identity](../product-enrichment/references/product-identity.md).
   An exact-variant identifier match resolves the line straight to that Product
   (`existingId`); a descriptive-only match does not — choose `new` for this
   line's own vendor Product instead, then call `product_enrichment.propose_match` with
   the candidate pair and evidence for human review. Otherwise choose an
   existing Product shortcode, explicitly choose `new`, or leave the line
   `unresolved`. Never create a Product merely because search was
   inconclusive, and never claim a descriptive-only candidate directly.
   Every order is household spending, but not every line is a stocked item:
   choose `expense_only` for prepared food and drinks from a restaurant or
   delivery order, event or travel tickets, rides, donations, and paid labor
   or delivery. The line books an expense with no Product and nothing to
   review; a spending category with `productExpectation: not_allowed` (a
   restaurant) refuses a Product outright. Seeds, plants, ingredients,
   groceries, tools, and supplies are stocked items, never `expense_only`,
   and so is software and any subscription the household tracks or that
   ships goods (a software license, a seed club, pet-food autoship): resolve
   those to their Product.
5. Call `purchase_import.commit` with the preparation revision and every line
   resolution. Do not use generic entity creation for imported Products or
   Expenses.
6. Inspect every ordered result. `created`, `updated`, and `replayed` are
   terminal; `conflict` requires review.
7. Report every conflict or open finding; resolve it through the Problems UI.

For an agent run, call `claim_next_import_work` before selecting an evidence
path and after each committed item. Account-sync work is a `cursor_walk`
(capture the order-history page; importing it records an `order_list` of
orders with `nextPageUrl`, or `null` once the page predates the account
cursor), then one `order` at a time (capture and import its detail page),
then hunts and enrichment; `finish_import_run` refuses while a listed order
is still pending. A backfill run walks an explicit date range of older history
and never moves the incremental cursor. `defer_order_for_review` leaves one
ambiguous order for review while the others continue; the run then ends in
review rather than reporting a complete import, and a restart retries it.
A member can also select statement charges for one run
(`vendor.startChargeRun`, from the Vendor account's Statement charges
section): the run's work is exactly those charge hunts, each claimed as a
`hunt` item with its `id`, and it never walks order history or joins another
hunt. Find the charge's order on the vendor account and import it normally;
the server settles the hunt only when the charge is uniquely and conservatively
allocated (an amount or date coincidence, or your ranking, is review, never a
settlement). When a hunt stays unsettled, record it with
`settle_charge_hunt`: `not_found` after searching the vendor account's history
for the charge's amount and date window without a matching order, or
`needs_review` when a candidate order stays ambiguous or unreadable (it leaves
one finding naming the charge). A charge the server already settled reads as
resolved whatever you report. `finish_import_run` refuses while any selected
hunt is still queued, and the run ends in review unless every charge resolved;
a restart retries every unresolved selected charge. Imports and settlement
never change stock. A `receipt_evidence` item must go through
`extract_receipt_evidence`, whose immutable source/checksum/extraction payload
is passed unchanged to `purchase_import.prepare`; it is not a separate writer.
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
`imports_read.purchase_status` with its original operation id. Repeating
the source payload is replay, not a way to revise a reviewed decision; a
correction creates a linked successor run and new decision revision.

## Learn a vendor

Create or update the Vendor deliberately, then configure:

- `orderEvidence`: `online_account`, `receipt_only`, or `not_expected`. It says
  where to look, never whether evidence is wanted; the resolved
  `evidenceExpectation` (transaction, then vendor, then category) decides
  that, so a required charge from a `not_expected` vendor still opens a
  `receipt_required` hunt. Creating a browser-synced account for a vendor with
  `browserDomains` fills only an unset value with `online_account`; an
  explicit choice is never overwritten and weaker signals stay unset for the
  `vendor_order_evidence` gap. Contradictory choices (`not_expected` source
  with a required vendor policy, or a not-expected policy with a source) show
  as `vendor_order_evidence_conflict`; resolve by changing one field;
- `browserDomains` and `orderUrlTemplate` for online accounts;
- `orderEmailSenders` only for verified senders outside the website domain;
- `returnWindowDays` only when the policy is known.

The website domain is the default Gmail sender signal. When two Vendors share
that domain, an exact configured sender takes precedence; other ambiguous mail
stays for review. Recognized order mail with an explicit order id creates a mail-only VendorAccount
for that member when one does not exist. This records a vendor relationship,
not proof of a browser login. Turn on browser sync (set the account's
`browserSyncEnabled` and status `active`) only after confirming that member's
online account; use Sync now while the Mac app and chosen browser are open.
Mail that names the exact order id of the one live Purchase for its Vendor links
itself (a `cubby-system` decision), whichever arrived first; a member's
dismissal is never overridden. Review the remaining candidate links (amount and
date matches) or dismissals from the Vendor's Order email worklist. A mail
import's Purchase belongs to the member's VendorAccount; the import run itself
has none, so it never walks order history. After a mail import commits, each
new Product gets its confirmation line's thumbnail as a provisional cover (a
verified catalog image from enrichment takes cover ahead of it), and when the
account is browser-synced, one `product_enrichment` run starts at the product
pages the email linked (`Run.input.kind = post_import_enrichment`). Treat cached navigation hints as advisory observations within
`browserDomains`.

For every exact merchant descriptor observed on that member's statement, call
`purchase_import.confirm_vendor` after the human/vendor mapping is known.
Charge-driven hunts leave unmapped descriptors for review.

## Settlement

Load [financial-settlement.md](references/financial-settlement.md). Match literal
posted charges or refunds to Purchases; one transaction may allocate across
several Purchases and one order may have several shipment charges. Do not create
synthetic transactions. If evidence is incomplete, leave settlement unresolved.
For a unique full payment set, verify amount, account/card identity and a
bounded date window; a statement row may have only `postedDate`. A late
statement still needs the same check against Purchases already imported.
Same-amount nearby charges, split tender, wallet aliases, and shipment splits
are review cases unless the full allocation is uniquely supported. Amount or
date coincidence, a subset of charges that happens to sum to the order total,
the nearest date, and a model ranking only rank candidates; none settles by
itself. When identical candidates stay indistinguishable, leave the choice for
review instead of picking one.
Monarch rows prove settlement, not itemization or exact Product identity. Use
email/order lines for items and prefer matching existing photo-created Products
when variant evidence agrees. Keep historical Expense attribution separate from
current inventory ownership. Reconciliation never receives that inventory again.
Record a historical acquisition (a known quantity whose earlier purchase is missing) as an Expense with `cost: null`, no `date`, and the known `productQuantity`; never invent price or date, and it receives no inventory.

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
approval in an agent run, including the `entity.create`/`entity.update` steps
the settlement reference describes; prose in a prompt is never approval.
Reference steps that use a live browser console, scripts, or file parsing
(payment-ledger scraping, statement CSV parsing) are for an interactive Claude
or Codex session; an agent run uses only its mounted tools and retained evidence. Receiving remains a human
decision and inventory never changes merely because an order arrived.

## Completion report

Report source coverage by outcome, touched Purchases, settlement matches,
enrichment performed, and every open finding. State that inventory was not
received.
