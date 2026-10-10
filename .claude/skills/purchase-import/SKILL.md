---
name: purchase-import
description: Support Cubby purchase imports when learning a vendor, importing an order Email, receipt or vendor export, resolving order Email, or reconciling financial settlement.
---

# Purchase-import support

Pi's unattended Mail import follows [mail-import.md](references/mail-import.md).
For receipt or retained mail extraction and post-commit audit, load the
respective [extraction](references/extraction.md) and [audit](references/audit.md)
instructions. For a photographed receipt or a Gmail order event, load
[receipt extraction](references/receipt-extraction.md) or
[order mail](references/order-mail.md). Pi, Codex and Claude share these
contracts and the same public Cubby tools (ADR 0008).

Pi turns classified Email into Purchases, Expenses and Product resolutions
without a browser. A member's Claude or Codex session does everything that needs
a browser, a logged-in retailer page or adaptive web research: it works the
Research queue (Burn-down) and imports through the same writers. Cubby owns
ownership checks, retained-Email checksums, replay, money conservation and
safe writes. Source-backed orders pass through `purchase_import` rather than
generic entity mutation.

Use `imports_read.run_status` to inspect an existing Run before controlling it.
`run.lifecycle` supports `controlAction: cancel`, `retry` or `restart` through
the shared member-owned controls. It does not approve findings, authorize paid
inference or verify unfinished targets. Respect an explicit member pause: do
not retry or restart until imports are resumed. Follow the returned successor;
the preceding attempt remains immutable.

## Connect and converge evidence

1. Connect Google with read-only Gmail access. Prioritize known Vendors and
   unmatched financial transactions, then paginate all retained history,
   including archives and unfamiliar vendors, excluding Spam and Trash. Jev
   routes relevant mail and escalates uncertainty to the relevance model; each
   message records which stage decided and why. An
   unrelated message retains only its provider identity and scan/classification
   status; related originals and useful attachments become retained evidence.
   A historical launch needs its separately approved backfill allowance;
   pilot candidate and Product limits, and continuous new-mail's monthly
   metered allowance, are independent. Confirmation,
   shipping, delivery, cancellation and refund mail may link to one Purchase.
   An exact order id helps; a unique supported match can use account, items,
   dates, totals, tracking or thread context together. Sender, thread or model
   confidence alone does not establish that match. Shipping mail can establish
   an incomplete identified Purchase while itemization stays unknown. What an
   Email cannot establish (a logged-in order page, the exact variant, an
   image) waits in the Research queue for a member's Claude or Codex session.
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

Pi's host coordinates Mail import steps, progress and review stops.
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
- Imports are member-owned. The authenticated member owns the import Run, the
  retained Email (its mailbox) and any named VendorAccount through
  `LedgerParty.userId`.
- Public identifiers are shortcodes. Never expose private UUIDs to the user.
- A source row is replay-safe only when its kind, external key, and checksum are
  stable. If the same source key changes, stop on the conflict.
- A try-before-you-buy order is trial custody, not item ownership or a paid
  purchase. Stop for review until final keep/charge evidence identifies the
  retained lines; its initial displayed total cannot be committed as spend.
  A final charge for retained items does not make the order page's returned
  items purchased.

## Vendor export

1. Resolve the Vendor (`vendorId`, or `vendor.name` to reuse or create an
   exact-name Vendor).
2. Collect one preparation payload per order: stable source identity, header, printed
   grand total and currency, item and adjustment lines, shipment state,
   transaction evidence, and finalized document image shortcodes.
   De-duplicate saved snapshots by stable order id. A generic mail subject may
   omit the brand and variant; search sender, order id, and time window, then
   inspect the order page for itemization.
3. Call `purchase_import.prepare` in batches of at most 50 orders, with a
   stable `_runExecution.operationId`. Without a Run, a member's preparation
   opens its own import Run and returns its `RUN-` code; pass it back as
   `_runExecution.run` to commit. Preserve the preparation revision and stable
   line ids. A retained Email source is `mail_message` with key
   `gmail:<mailboxId>:<messageId>` and the checksum `imports_read.mail` returned;
   committing it links the Email to the Purchase.
4. Resolve every principal line. Prefer exact-variant identifiers: a
   per-variant retailer SKU, ASIN, UPC/GTIN, or exact manufacturer part number.
   A style, family, or model number shared by sizes or colors only ranks
   candidates. Then inspect Product aliases, names, and details. Before
   choosing `new`, check inventory-first Products (`dataGap: product_unpurchased`,
   same category/owner) — see the either-side-first contract in
   [product identity](../product-enrichment/references/product-identity.md).
   An exact-variant identifier match resolves the line straight to that Product
   (`existing`). So does a candidate whose name or alias is the line's exact
   title (same brand, item, size, count, and variant) when none of its
   recorded fields contradicts the line: a missing identifier alone is no
   reason to fork it. A descriptive-only match — a similar but not identical
   name, such as a photo Product described from its tag — does not resolve
   the line: choose `new` for this line's own vendor Product instead, then
   call `product_enrichment.propose_match` with the candidate pair and
   evidence for human review. Otherwise choose an
   existing Product shortcode, explicitly choose `new`, or leave the line
   `unresolved`. When the line proves a purchased item but catalog identity
   remains incomplete, save only its supported Product facts and continue
   research after checking existing matches. Preserve the original order-line
   evidence; a descriptive-only candidate is not a direct match.
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
   Expenses. A commit never starts Product research; unresolved Product facts
   wait in the Research queue.
6. Inspect every ordered result. `created`, `updated`, and `replayed` are
   terminal; `conflict` requires review.
7. Report every conflict or open finding; resolve it through the Problems UI.

Mail import is Pi's version of this flow; [mail-import.md](references/mail-import.md)
adds the Email dispositions (`mail.resolve`: a lifecycle `linked` event,
`unresolved` with its gap, or `unrelated`). A member resolves an Email the same
way.

An interrupted mutation is recovered through
`imports_read.purchase_status` with its original operation id. Repeating
the source payload is replay, not a way to revise a reviewed decision; a
correction creates a linked successor run and new decision revision.

## Learn a vendor

Create or update the Vendor deliberately, then configure:

- `orderEvidence`: `online_account`, `receipt_only`, or `not_expected`. It says
  where to look, never whether evidence is wanted; the resolved
  `evidenceExpectation` (transaction, then vendor, then category) decides
  that. An explicit choice is never overwritten and weaker signals stay unset
  for the `vendor_order_evidence` gap. Contradictory choices (`not_expected` source
  with a required vendor policy, or a not-expected policy with a source) show
  as `vendor_order_evidence_conflict`; resolve by changing one field;
- `orderUrlTemplate` for online accounts, so a Burn-down session can open the
  exact order page;
- `orderEmailSenders` only for verified senders outside the website domain;
- `returnWindowDays` only when the policy is known.

The website domain and configured senders are search hints, not purchase
relevance gates. A new Vendor or member-owned VendorAccount may be created from
sufficient retained purchase evidence. This records a vendor relationship,
not proof of a login.
Related mail can converge on the same Purchase in either arrival order. Preserve
explicit member link and dismissal decisions. Competing supported matches stay
unresolved. A cancellation or refund can attach evidence and record its event;
changing existing Expenses or writing refund Expenses requires review.
Imported Products with identity, image or category gaps appear in the Research
queue (the `research-queue` saved views); nothing starts research automatically.
Preserve order-line URLs and original evidence. Product research starts from
those originals and authenticated order history; broader name search recovers
missing sources or unresolved facts. A missing saved snapshot is a context gap,
not proof the email or account lacks exact links. An order thumbnail remains
provisional until exact-variant research verifies a representative image.

For every exact merchant descriptor observed on that member's statement, call
`purchase_import.confirm_vendor` after the human/vendor mapping is known.

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

## Enrichment

Work unresolved Products with the `product-enrichment` skill (Burn-down).
Prefer stable vendor identity such as SKU, ASIN, UPC, or model. Leave ambiguous
identity as a finding and preserve human-linked Products. An inventory-photo
handoff matches an existing Product; it does not turn an unresolved photo into
a new purchase-import Product or inventory.

## Agent authority

Pi's Mail import mounts only Email reads, `mail.*`, `purchase_import` and read
tools; any other write needs a member's approval. A member's Claude or Codex
session writes with the member's authority and records Sources on what it
changes. Financial corrections use explicit review. Receiving remains a human
decision and inventory never changes merely because an order arrived.

## Completion report

Report source coverage by outcome, touched Purchases, settlement matches,
enrichment performed, and every open finding. State that inventory was not
received.
