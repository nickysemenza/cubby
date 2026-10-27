---
name: purchase-import
description: Support Cubby purchase imports when learning a vendor, importing an order Email, receipt or vendor export, resolving order Email, reconciling financial settlement, or booking shared-cost repayments.
---

# Purchase-import support

Pi's unattended Mail import follows [mail-import.md](references/mail-import.md).
For receipt or retained mail extraction and post-commit audit, load the
respective [extraction](references/extraction.md) and [audit](references/audit.md)
instructions. For a photographed receipt or a Gmail order event, load
[receipt extraction](references/receipt-extraction.md) or
[order mail](references/order-mail.md). Pi, Codex and Claude share these
contracts and the same public Cubby tools (ADR 0010).

Pi turns classified Email into Purchases, Expenses and Product resolutions
without a browser. A member's Claude or Codex session does everything that needs
a browser, a logged-in retailer page or adaptive web research: it works the
Research queue (Burn-down) and imports through the same writers. Cubby owns
ownership checks, retained-Email checksums, replay, money conservation and
safe writes. Source-backed orders pass through `purchase_import` rather than
generic entity mutation.

Start backlog triage with `activity_read.queue`: it offers the connected
member's current source/account work plus shared research, filterable by
`family`, `executor`, `reason` and `owner`. Its household UI is the Work queue
page, with an Owner filter. Unknown private ownership requires review; queue membership does not
authorize imports, paid execution or access to another member's originals.
Route paperwork and itemization research by source ownership. Paying for an
order does not establish access to its originals; settlement reconciliation
also requires the relevant financial-account authority.

In a member's interactive Burn-down, resolve obvious duplicate Purchases and
booked Expenses under [duplicate bookkeeping](references/duplicates.md).
Its evidence and impact checks allow routine cleanup without another
confirmation; ambiguous identity, attribution or money still needs review.

Use `run_read.work_snapshot` to inspect an existing Run before controlling it.
Use `run_read.transcript` for its committed coordinator messages and exact
tool inputs, results and errors. Follow `nextCursor` until null; this read does
not authorize or start execution. An absent conversation may have been retired
and is not proof that the Run never executed. Running snapshots can change
between pages; live generation partials, credentials and binary bodies are omitted.
Retired coordinators return an absent transcript without reopening storage or
execution; their retained Run status, operations and source associations remain
separate evidence.
`run.lifecycle` takes every Run `controlAction` (cancel, retry, restart,
resume …) through the shared member-owned controls; cancel refuses a Run that
already ended. Spending and review decisions (`run.set_mail_import`,
`run.discover_mail`, `run.commit_prepared`, `activity.resolve_run_finding`) are
callable, but only on the member's explicit instruction; never infer one.
Per-operation approvals no longer exist. Runs that were approval-paused are now
member `paused`, and their never-run operations are `failed` ("Approval pause
retired before the operation ran"). Replaying a failed operation id is refused;
after the member resumes the Run, re-issue that work under a new operation id.
Respect an explicit member pause: do
not retry or restart until imports are resumed. Follow the returned successor;
the preceding attempt remains immutable.

An explicit `purchase_import.email_import` selection — up to 50 Emails, each by its `id`
(`EML-` code) and current checksum as `purchase_import.mail_search` and `purchase_import_read.mail_read`
return them — starts Luna as foreground work outside the household AI budget. An Email with no order id that is already linked to exactly
one Purchase imports into that Purchase rather than booking a second one.
Member-controlled retries
keep their frozen source scope. These selected Luna calls have no dollar ceiling;
this does not authorize another paid model, another member's sources, or
receiving stock. Ownership, retained originals,
checksums, replay, money conservation and unresolved-identity review still apply.

## Connect and converge evidence

1. Connect Google with read-only Gmail access. Discovery and classification
   continue independently of automatic import. Turn Mail import on for the
   mailbox (`run.set_mail_import`, only on the member's instruction) to admit
   new unattended imports; enabling queues immediate catch-up. Turning it off
   leaves explicit imports and existing Run controls available. Discovery searches known Vendors' verified senders and website domains
   and unmatched transaction merchants, and reads new mail from all senders,
   excluding Spam and Trash; there is no all-of-Gmail crawl. The decision model
   routes relevant mail and escalates uncertainty to the relevance model; each
   message records which stage decided and why. An
   unrelated message retains only its provider identity and scan/classification
   status; related originals and useful attachments become retained evidence.
   Frontier chat-model calls share the household AI budget, a $1 per six-hour
   UTC safety net; classification, decision models and embeddings are not
   budgeted (`run_read.mail_import` shows the window).
   Confirmation,
   shipping, delivery, cancellation and refund mail may link to one Purchase.
   An exact order id helps; a unique supported match can use account, items,
   dates, totals, tracking or thread context together. Sender, thread or model
   confidence alone does not establish that match. Shipping mail can establish
   an incomplete identified Purchase while itemization stays unknown. What an
   Email cannot establish (a logged-in order page, the exact variant, an
   image) waits in the Research queue for a member's Claude or Codex session.
   That session opens the Vendor's `orderUrlTemplate` page for the order id
   in the member's signed-in browser before deciding whether an order was
   cancelled, returned, partly shipped or a specific variant, and before
   asking the member: the order page is the authoritative record, and an
   email's later silence is not.
2. For Monarch MCP transactions or statement exports, use
   [financial-evidence-import](../financial-evidence-import/SKILL.md). That skill
   owns client parsing, complete source enumeration, normalization and bounded
   `finance.record` calls. Cubby owns scheduling, matching and booking;
   financial intake does not chain agent transaction/Expense writes. Inspect
   retained Source transaction records and Transaction imports through
   `entity_read` (`sourceTransactionRecord` / `transactionImport`), using their
   declared projections rather than specialized roster APIs.
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
the columns and sign before saving. The decision model can rank a bounded set of ambiguous
account, transaction, or Purchase candidates using evidence. A choice is a
proposal for review, not a settlement write or an inferred transaction.
The [human journey](../../../docs/guide/product-identity-journey.md) describes the
same outcome without prescribing an agent runtime.

## Invariants

- `SUM(Expense.cost)` is the only spend ledger. A Purchase describes an order;
  a FinancialTransaction is settlement evidence.
- One order or receipt is one Purchase ([naming policy](../../../docs/guide/terminology.md#naming-policy)).
  Separate charges at one venue or event (each festival stand, each bar tab)
  are separate Purchases grouped by their Project, never one event Purchase:
  funders derive per Purchase, so grouping blends every card into every line.
- Shipment evidence records packages and their source observations, with an
  optional Purchase association. Follow [shipment intake](references/order-mail.md#record-shipment-evidence)
  for Email, Shop and interactive tracking pages. A partial package timeline
  never proves whole-order delivery. Inventory changes only by a deliberate
  member action; imports and shipment events never receive stock.
  For tracking enrichment, load that reference's carrier and third-party
  tracker guidance; outgoing postage is a service purchase, with outgoing
  Shipments linked to it and its Expenses assigned to the member's Project.
- Use source totals and itemization exactly as printed. Never scale lines to
  `statedTotal`, infer tax, or fabricate a transaction to close a gap.
- Unknown facts stay unknown. A missing cost, date, quantity, or order id is
  recorded as absent, never as zero or a guessed value.
- A line that only adjusts the order (a bag fee or bag refund, a delivery or
  pickup charge, a tip, a coupon) takes its adjustment receipt role (`fee`,
  `shipping`, `tip`, `discount`, `other_adjustment`), even at $0. Never bind it
  to a Product: a principal line's Product decides its Spending Category, and
  an adjustment follows the order's item lines instead.
- A warranty source that explicitly states free replacement hardware proves
  zero cost for those parts. Resolve the replacement parts themselves; the
  original tool's model identifies compatibility, not another whole tool
  acquisition. Generic warranty codes shared across parts are not exact-variant
  identifiers. Keep an unmatched part open for source-preserving reviewed
  identity resolution; lack of a paid charge is not the remaining gap.
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

For an interactive account-history sweep, enumerate every page and keep an
order-by-order worklist through import, settlement and Product enrichment.
Continue until each source order has a verified outcome or a specific blocker;
the size of the history or a progress report is not a stopping condition.
Compare the worklist with existing Purchases before creating anything, and use
the financial-evidence skill to check available statement sources. A candidate
charge is not a settlement until the settlement checks establish the match.

1. Resolve the Vendor (`vendorId`, or `vendor.name`). A name resolves by
   Sender proof first (an exact sender address one Vendor records, or a sender
   at the website domain of exactly one Vendor; either saves the name as a
   Vendor alias), then by the Vendor's exact name or alias ignoring case. A
   shared mail, storefront, payment or relay domain never matches, and a name
   two Vendors share is refused. A new Vendor beside a similar-name or
   same-domain candidate is refused until `vendor.distinctFrom` names each
   with the URL and quoted text showing the difference; prepare returns them as `vendorCandidates`. Merge real
   duplicates, which keeps the merged names as aliases. Sender proof refuses a
   merchant name another Vendor already answers to; pass that order's
   `vendorId`. `entity.resolve {entity:"vendor", names}`
   shows a name's Vendor without creating one.
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
   `gmail:<mailboxId>:<messageId>` and the checksum `purchase_import_read.mail_read` returned;
   committing it links the Email to the Purchase.
4. Resolve every principal line. Prefer exact-variant identifiers: a
   per-variant retailer SKU, ASIN, UPC/GTIN, or exact manufacturer part number.
   A style, family, or model number shared by sizes or colors only ranks
   candidates. Then inspect Product aliases, names, and details. Before
   choosing `new`, include inventory-first Products (`dataGap: product_unpurchased`);
   category and owner rank candidates without excluding missing metadata — see the either-side-first contract in
   [product identity](../product-enrichment/references/product-identity.md).
   An exact-variant identifier match resolves the line straight to that Product
   (`existing`). So does a candidate whose name or alias is the line's exact
   title (same brand, item, size, count, and variant) when none of its
   recorded fields contradicts the line: a missing identifier alone is no
   reason to fork it. Commit enforces this: `new` is refused beside a
   candidate flagged `exactIdentifierMatch`, and beside one flagged
   `exactNameMatch` or a strong brand/item review candidate unless the
   resolution's `distinctFrom` names it with the url and quoted text that show
   the difference (model, size, pack, kit
   contents). Browse the listings to find that difference; without one,
   resolve to the match. For a differently titled photo Product, compare its
   own photos, labels and research notes against the purchased variant before
   choosing a resolution, following [product identity](../product-enrichment/references/product-identity.md).
   Reuse a supported same-variant match; leave ambiguity `unresolved`; choose
   `new` only after distinguishing the reviewed candidates. Preserve the
   original order-line evidence and save only supported facts when catalog
   research remains incomplete. A new Product's unknown maker stays
   `(unspecified)`, never `generic`; mark loose produce and other goods with no
   single listing `commodity: true` per
   [product enrichment](../product-enrichment/SKILL.md).
   Every order is household spending, but not every line is a stocked item:
   choose `expense_only` for prepared food and drinks from a restaurant or
   delivery order, event or travel tickets, rides, donations, and paid labor
   or delivery. The line books an expense with no Product and nothing to
   review; a spending category with `productExpectation: not_allowed` (a
   restaurant) refuses a Product outright. Seeds, plants, ingredients,
   groceries, tools, and supplies are stocked items, never `expense_only`,
   and so is software and any subscription the household tracks or that
   ships goods (a software license, a seed club, pet-food autoship): resolve
   those to their Product. An `expense_only` line has no Product to classify
   it, and a vendor default only covers food, restaurant and coffee vendors,
   so after commit give the rest (paid labor, a venue, tickets) a Spending
   Category with a reviewed `spending_classification_read.preview` then
   `spending_classification_write.apply` (`action: "expenses"`); left alone it
   lands in Uncategorized.
5. Call `purchase_import.commit` with the preparation revision and every line
   resolution. Do not use generic entity creation for imported Products or
   Expenses. A commit never starts Product research; unresolved Product facts
   wait in the Research queue. For an existing Purchase with exact manual
   item Expenses, explicit `new` or `existing` choices bind uniquely matching,
   unbound, unclaimed principal rows and retain the original source-line
   associations. Amounts, dates, purpose and adjustment rows stay intact.
   To correct a Product on an already-imported item, use the ordinary Expense
   entity update: set its `productId` and `productQuantity`. Create a missing
   Product through normal entity creation first. The Expense owns the current
   Product; retained receipt identifiers follow its live binding. This does
   not require an accepted-source handle, original preparation or a new import.
   Keep the item's amount, date, Purchase and other classifications unchanged.
   Clear `productId` to remove the binding; this also clears its quantity.
   Read the Expense back to verify. Importing or correcting a Product never
   receives stock.
   Use source-order reconciliation for changed itemization or financial facts,
   rather than for ordinary Product corrections. Its existing accepted-source
   writer remains available for specialist source-line review; it preserves
   money and stock and refuses ambiguous or changed original bindings.
   A source-order reconciliation finding whose source differs from manual
   Expenses (a single manual line versus an itemized original) is applied in
   two steps. First `prepare_reconciliation` with the finding `id` and a
   `replace_lines` resolution: list the replaced `expenseIds`; give every
   proposed line, including shipping, tax and zero-amount lines, exactly one
   binding whose `expenseId` names the replaced Expense it inherits context
   from; bind principal lines to an existing `productId` (create a new Product
   first through entity creation when none exists, since `newProduct` needs a
   known accepted original); and, when the total changes, pass
   `attributionTargets` for beneficiary and funder. Copy the parties from the
   preview's `originalAttributions`: an empty `beneficiaries` field on the
   Expense can still resolve to a named party. Then
   `activity.resolve_run_finding` with `apply` and the returned `reviewedFingerprint`.
6. Inspect every ordered result. `created`, `updated`, and `replayed` are
   terminal; `conflict` requires review.
7. Resolve the Purchase's VendorAccount before reporting completion. List the
   Vendor's existing accounts and reuse the account belonging to the evidenced
   member; create one when the source establishes that relationship and none
   exists. Link it through Purchase.vendorAccountId and read it back. A signed-in
   account invoice is sufficient evidence; ambiguous ownership stays unresolved.
   Read back every principal merchandise line's Product binding and source
   association, the Expense row count and the printed
   total versus `SUM(Expense.cost)`, order/Expense dates and date provenance.
   Confirm original inventory quantities and own-photo covers survived. For
   an existing stocked item with a priced acquisition, check its derived
   valuation; a Purchase-Product link alone supplies no cost basis.
   Report every conflict or open finding; resolve it through the Problems UI.

Mail import is Pi's version of this flow; [mail-import.md](references/mail-import.md)
adds the Email dispositions (`purchase_import.mail_resolve`: a lifecycle `linked` event,
`unresolved` with its gap, or `unrelated`). A member resolves an Email the same
way.

Lifecycle resolution names all supported `purchaseIds`. A combined refund
may also carry a member-reviewed `settlement`: existing posted refund references,
their reviewed accounts, literal source account labels and reasons. Verify the
credit sum and each existing allocation before writing. These associations
retain the checksum and account review through later deletion or account drift;
they never change money, account aliases, allocations or stock.

An interrupted mutation or a tool response that does not show a usable result is recovered through
`purchase_import_read.operation_status` with its original operation id. Repeating
the source payload is replay, not a way to revise a reviewed decision; a
correction creates a linked successor run and new decision revision.

## Learn a vendor

Create or update the Vendor deliberately, then configure:

- `spendingProfile`: `food_retail` for a grocer or food and drink seller,
  `mixed_retail` for a store that sells food among other goods, `restaurant`
  or `coffee_shop`. Food Product Categories only map to a Spending Category at
  food and mixed retailers, so an `unspecified` grocer leaves its food lines
  Uncategorized. Change an existing Vendor's profile through a reviewed
  `spending_classification` preview and apply (`action: "vendor"`).
- `orderEvidence`: `online_account`, `receipt_only`, or `not_expected`. It says
  where to look, never whether item lines are wanted; the resolved
  `itemizationExpectation` (transaction, then vendor, then category) decides
  that, and no policy requires a receipt document. An explicit choice is never
  overwritten and weaker signals stay unset for the `vendor_order_evidence`
  gap. The one contradiction is a `not_expected` source with a `required`
  itemization policy (`vendor_order_evidence_conflict`); resolve it by changing
  one field. An in-store shop whose receipts are sometimes kept is
  `receipt_only` with itemization `not_expected`;
- `orderUrlTemplate` for online accounts, so a Burn-down session can open the
  exact order page;
- `orderEmailSenders` only for verified senders outside the website domain;
- `returnWindowDays` only when the policy is known.
- `agentHints.notes` for anything learned about recovering this Vendor's
  orders or identifiers (archived order lists, legacy lookups, where item
  numbers appear, image pitfalls). Vendor-specific findings are household data:
  they belong on the Vendor, never in repository docs, skills or PRs.

The website domain and configured senders are search hints, not purchase
relevance gates. A new Vendor or member-owned VendorAccount may be created from
sufficient retained purchase evidence. This records a vendor relationship,
not proof of a login.
Related mail can converge on the same Purchase in either arrival order. Preserve
explicit member link and dismissal decisions (`purchase_import.email_purchase_decide`, per Email
and Purchase); an import-accepted source cannot be dismissed. Competing
supported matches stay unresolved. A cancellation or refund can attach evidence and record its event;
changing existing Expenses or writing refund Expenses requires review.
Imported Products with identity, image or category gaps appear in the Research
queue (the `research-queue` saved views); nothing starts research automatically.
Preserve order-line URLs and original evidence. Product research starts from
those originals and authenticated order history; broader name search recovers
missing sources or unresolved facts. A missing saved snapshot is a context gap,
not proof the email or account lacks exact links. An order thumbnail remains
provisional until exact-variant research verifies a representative image.

For every exact merchant descriptor observed on that member's statement, call
`purchase_import.confirm_merchant_vendor` after the human/vendor mapping is known.

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

A card's primary cardholder and dated authorized users decide who a charge
belongs to. A card with neither cannot attribute a Purchase's purchaser.
Payment convergence returns review-required ("a dated, confirmed funding
account") unless the household or the member funds the charge date and the
member owns the account, is its primary cardholder, or is an authorized user
then. Confirm the holder or funding period with the member before retrying.

Statement previews carry `importFingerprint` and `rowPosition` on every row so
two identical same-day charges keep distinct source references.

## Repayments and shared costs

Money a non-member sends back for a cost the household fronted is a Credit: a
`reimbursement` Expense on the Purchase it repaid, booked from the incoming
transaction with `finance.book_transaction`. A repayment between members is a
Ledger Transfer. A vendor refund is a negative Expense on its order. None of
them is a new Purchase of goods. Record a return as a negative principal line
for the returned item (its Product, or an explicit Spending Category); a
refund adjustment on an order whose items were bought stays Uncategorized by
design. For a group trip or a shared-expense export (Splitwise and similar),
load [household-ledger.md](references/household-ledger.md).

## Enrichment

Work unresolved Products with the `product-enrichment` skill (Burn-down).
Prefer stable vendor identity such as SKU, ASIN, UPC, or model. Leave ambiguous
identity as a finding and preserve human-linked Products. An inventory-photo
handoff matches an existing Product; it does not turn an unresolved photo into
a new purchase-import Product or inventory.

## Review Email accuracy

Use [decision grading](../decision-grading/SKILL.md#email-relevance) for blind
samples, original/checksum verification, member grades, weighted reporting and
before/after comparisons. A review does not authorize a production
reclassification or change the frozen sample. Report unavailable originals and
coverage limits alongside accuracy.

## Agent authority

Pi's Mail import mounts only Email reads, `mail.*`, `shipments.record`, `purchase_import` and read
tools; any other write needs a member's approval. A member's Claude or Codex
session writes with the member's authority and preserves research in notes.
Evidence-backed interactive duplicate cleanup follows
[duplicate bookkeeping](references/duplicates.md) without another confirmation.
Other financial corrections require the member's unresolved decisions and the
writer's explicit reconciliation review. Receiving remains a human decision
and inventory never changes merely because an order arrived.

## Completion report

Report source coverage by outcome, touched Purchases, settlement matches,
recorded Shipments and unmatched package evidence, enrichment performed, and every open finding. State that inventory was not
received.
