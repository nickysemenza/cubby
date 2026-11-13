# Purchase, photo, and statement evidence

This page owns how imported evidence converges into Purchases, Expenses,
Shipments and FinancialTransactions: statement booking, shipment intake,
financial-mail convergence, itemization, source-record identity, normalized
financial intake and statement review. Mail import itself (discovery,
admission, the coordinator) is in the
[purchase-import module guide](../apps/web/src/server/domains/purchase-import/service/README.md);
spending categories are in [spending classification](spending-classification.md).

Source-reference invalidation checks include removed observations: a retained
reference to a deleted, ignored or superseded observation invalidates current
advice. The source/external-ID lookup index therefore includes tombstones; the
separate live-only unique index still enforces active observation identity.

## Money rules

Pure policy lives under `apps/web/src/server/domains/<domain>/policy/`.
Repositories load evidence and submit observations and decisions. The kernel
owns applying the money reconcilers under its household write gate. Empty searches are evidence too: loaders must supply empty arrays
and explicit missing rows rather than omit competing candidates.

| Domain / module                                         | Decision and read inputs                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transaction-import/source-intake-plan`                 | Occurrence head, withdrawal and membership plans from the complete `SourceOccurrence`, retained `SourceTransactionRecord`, `TransactionImport` and `TransactionImportRecord` rows in `SourceIntakeLoaded`, with an explicit observation time and prepared source fingerprints. Provider revisions without ordering proof have no selected head.                                                               |
| `transaction-import/source-identity-plan`               | Reviewed identity proof and the resulting owner changes from complete occurrence/observation rows, account identity, accepted transaction id, historical bindings, alias rows and reviewed expected versions. Missing heads, aliases and targets remain explicit inputs.                                                                                                                                      |
| `transaction-import/source-transaction-record-identity` | Provider identity and source-reference fingerprints from source, account, date, provider-signed amount, original descriptor and provider identity claims.                                                                                                                                                                                                                                                     |
| `transaction-import/statement-effective-movement`       | Effective sign and loan movement from provider amount, descriptor, merchant and category; loan authority reads live account/party identity, source aliases, provider account ids and Vendor names/aliases.                                                                                                                                                                                                    |
| `transaction-import/statement-transaction-kind`         | Kind votes, spending eligibility and person/payment-rail policy from effective amount, provider category, descriptor, account kind, transfer evidence and counterparty/rule/model/history votes.                                                                                                                                                                                                              |
| `transaction-import/charge-identity`                    | Stable charge key from occurrence source and charge key.                                                                                                                                                                                                                                                                                                                                                      |
| `transaction-import/transfer-pair`                      | Opposite-leg candidates, overlaps, competitors, clean/apply blockers and fingerprints from the complete loaded leg pool, including empty account/candidate searches and each leg's collection membership, account/owner, dates, signed amount, source refs, status-derived eligibility and labels.                                                                                                            |
| `financial-account/purchaser`                           | Live household spending/loan authority and individual purchaser from account identity/deletion, owner kind/deletion and dated primary-cardholder identity/deletion plus sole-access proof.                                                                                                                                                                                                                    |
| `financial-transaction/settlement-window`               | Three-day instant, calendar-date and prefilter bounds from explicitly supplied dates. Indexed loaders retain their declared candidate windows.                                                                                                                                                                                                                                                                |
| `financial-transaction/spending-prerequisites`          | Spending and Vendor-creation blockers from transaction kind/amount/date/source refs, account/owner, resolved purchaser, Vendor resolution ambiguity and counterparty/name/confidence/escrow advice.                                                                                                                                                                                                           |
| `financial-transaction/booking-action`                  | Link existing spending or create a lump from live Expense costMinor/future/economicRole/lineKind, carried-cost provenance, transaction amount and the sum of other same-direction eligible allocations.                                                                                                                                                                                                       |
| `financial-transaction/booking-fingerprint`             | Retained JSON fingerprints and fresh booking lineage from the exact supplied preview, serialized evidence and Expense row order.                                                                                                                                                                                                                                                                              |
| `purchase-import/import-plan`                           | Import write blocks from accepted extraction status/reason and candidate currency, order date, total and line prices.                                                                                                                                                                                                                                                                                         |
| `purchase-import/import-lines`                          | Exact line matching, aggregate replacement eligibility and unique complete payment matching from existing Expense identity/title/amount/role/product/quantity/source claim, extracted lines, retained payments and all eligible charge candidates.                                                                                                                                                            |
| `purchase-import/accepted-source`                       | Accepted-source financial replay and Product-choice guards, original line binding, target review and tender learning from accepted extraction, proposed extraction, `ImportSourceOrder.originalOrder`, `ImportSourceProduct` bindings, merged Product identities and retained `PurchasePaymentEvidence` amountMinor/chargedAt/cardLastFour/tender. Empty retained/binding searches participate in the result. |
| `purchase-import/retained-payments`                     | Agreement across payment sources and order-date anchoring from `PurchasePaymentEvidence.sourceClaimId/amountMinor/chargedAt/cardLastFour/tender` in evidence-index order, plus `Purchase.date`. Discovery uses allocation presence and candidate charge facts.                                                                                                                                                |
| `purchase-import/replacement-attributions`              | Exact signed line and party margins from the resolved Expense allocation role/party/key/cents and accepted line minor amounts. Largest remainders use the party key as the tie-breaker.                                                                                                                                                                                                                       |

Repository wire adapters convert dollar inputs into signed minor units for
statement kind, effective movement and spending prerequisites. Booking capacity,
row intents, recorded splits, combined-charge conservation, payment matching and
attribution transport use minor units. Source-intake requests, transfer-pair
judgments and import extraction policies retain their wire-shaped inputs.
Frozen fingerprint envelopes retain their exact dollar fields and key order.
`digestValue`, source-identity hashes and transfer-pair fingerprints are
synchronous over plain data; a canonical evidence string uses
`digestValue({ evidence })`, with the same bytes as the streaming adapter.

The following functions share these explicit read contracts. Empty arrays and
missing lookup rows remain inputs to the decisions.

| Functions                                                                                                      | Declared reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `statementBookingRows`                                                                                         | FinancialTransaction amountMinor, shortcode, effective date and label; selected Purchase shortcode or absence; resolved account purchaser and Vendor; Expense category, role, cost type, trade, beneficiary decisions; prior eligible allocation capacity. Its Purchase/Expense references are intents resolved by the existing writers.                                                                                                                                                                                                                                                                                                                                                                                    |
| `decideSpendingCandidates`                                                                                     | Purchase id, shortcode, displayLabel, date, vendorId and deletedAt; Expense purchaseId, deletedAt, future, economicRole, costMinor, lineKind and bookingTransactionCode; PurchasePaymentEvidence purchaseId, amountMinor and chargedAt; FinancialTransactionAllocation purchaseId, transactionId, amountMinor and deletedAt; linked FinancialTransaction id, accountId, amountMinor, status, kind, deletedAt, ledgerTransferId and shortcode; FinancialAccount id and deletedAt; whole-transaction live allocation totals; reimbursement Expense existence. The indexed pool includes explicit Purchases, nearby payment amounts, nearby Vendor Purchases, positive-allocation Purchases and undated exact payment amounts. |
| `competingPaymentClaimants`                                                                                    | Purchase id/deletedAt; every other Purchase's same-amount PurchasePaymentEvidence purchaseId, amountMinor, chargedAt, tender and cardLastFour; FinancialTransactionAllocation purchaseId, amountMinor and deletedAt; all retained payment and live allocation totals of that sign, across every source, owner and Vendor.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `availableSpendingMinor`                                                                                       | Live Expense costMinor, lineKind, future, economicRole and bookingTransactionCode; linked allocation amountMinor; transaction/account deletion, transaction id, shortcode, kind, status, amountMinor, ledgerTransferId and whole-transaction allocation total.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `recordedSpendingOutcome`                                                                                      | Every live allocation Purchase id and amountMinor; every linked Purchase id, shortcode and capacity; explicit beneficiary intent; stored/current lineage equality.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `allocationSetViolation`                                                                                       | Transaction kind and amountMinor; the complete proposed allocation Purchase ids and amountMinor, including an empty set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `completePaymentMatches`                                                                                       | Complete retained payment amountMinor, chargedAt, cardLastFour and tender; every eligible charge id, amountMinor, occurredAt, cardLastFours and storedValue flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `groupMemberNamesCharge`, `combinedChargeAllocations`                                                          | Every requested live Purchase id, vendorId, date and statedTotalMinor; first accepted source-claim owner; normalized payment set and complete eligible charge set; allocation existence for the whole group.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `bookingVendorCreations`, `bookingVendorSelection`, `createdVendorConflict`                                    | Reviewed Vendor choices; Vendor id, shortcode, name, aliases and deletedAt for every raw and cleaned name's resolution candidates, including misses; live explicitly selected Vendors; creation results; a fresh resolution after minting. Creation aliases contain the distinct raw merchant label, except issuer card-fee labels.                                                                                                                                                                                                                                                                                                                                                                                         |
| `vendorPurchaseFolds`                                                                                          | Ordered keeper/loser Vendor ids and every live Purchase id, vendorId, orderId and notes. Null order ids never collide; existing keeper slots win, followed by loser order and Purchase id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `replacementLineFields`, `replacementAttributions`                                                             | Replaced Expense notes, date, future, costType, trade, projectId, spendingCategoryId and bookingTransactionCode; accepted line title, seller, minor cost and role; resolved per-role allocation party, key and cents. Only principal lines inherit Project/category; every line retains the other aggregate fields.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `duplicateSourceOrderReplay`, `duplicateSourceOrderRefusal`, `pairLines`                                       | EntityIdentity id/mergedIntoId and the survivor AuditLog convergence receipt; both live Purchases' vendorId, vendorAccountId, orderId, normalized order key and date; linked Email mailbox/thread identities; accepted duplicate source-order existence; financial source-claim existence; complete Expense id, title, costMinor, lineKind, Product, Project, quantity, economicRole, attribution and carried booking/category/trade fields on both Purchases.                                                                                                                                                                                                                                                              |
| `convergenceAccountAvailable`, `financialConvergenceRefusal`                                                   | Live transaction status, kind, amountMinor and ledgerTransferId; resolved dated funding party, account owner, actor member, primary holder, authorized-user periods and payment window; source refs; complete live allocations; accepted Purchase/Vendor identities; settlement conflicts; exact stored/current booking and lineage fingerprints. Load stages precede their corresponding decisions and preserve the existing write/lock sequence.                                                                                                                                                                                                                                                                          |
| `spendingCategoryForDiscovery`, `refundSpendingCategory`, `bookingSpendingCategory`, `reviewedCategoryRefusal` | Live SpendingCategory id, shortcode and deletedAt; explicit category and history-review intent; advice confidence/conflict; every Vendor category-history result; refund original's live Expense id, costMinor, lineKind, future and economicRole plus each effective category.                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Statement booking

Bank transactions are evidence; Expenses are the spending ledger. Statement
imports and re-imports discover booking work for every observed charge,
including unchanged observations already matched to an unbooked transaction.
Supported purchases and fees book spending automatically; ambiguous identity,
missing order details and unsupported facts remain machinery gaps. A member
resolves these gaps through durable kernel decisions. Transfers, card payments, earned interest and ordinary income
remain settlement-only: clean ones are created automatically without Expenses.
A uniquely supported opposite leg is created as a pair; an unpaired movement
with supported kind evidence can be recorded alone. Ambiguous pairings remain
in review.
All money continues to be `SUM(Expense.costMinor)`. Interest earned is recorded as
`interest` with an inflow; interest linked to a Purchase remains an outflow.

Pending or unknown provider status does not prevent an otherwise supported
booking, and spending advice is generated for pending and observed spending
under the same eligibility as posted spending. Unknown status is kept as null
on evidence and observed on the FinancialTransaction, never fabricated as
posted. Transaction booking and evidence coverage use those same observed,
pending and posted states: supported unbooked spending remains a booking gap
before posting, while expected or void transactions, transfers and ordinary
income stay outside that requirement. Stored quality flags adopt policy changes
through the quality refresh owner; a coverage-policy change starts no financial
Sweep or booking work.

### Purchaser evidence

Booking links recorded Expenses or creates one bare Purchase and one lump
Expense. Purchases created from bank evidence have no invented itemization,
order identifier or printed total. A new bare Purchase keeps a live member
account owner as purchaser; otherwise it uses the live primary member of a
household credit card only when no authorized-user period includes the spending
date (transaction date, then posted date). Otherwise-supported spending on a
live, household-owned credit card, bank account or stored-value account books
with an unknown individual purchaser, including shared access or missing
primary-cardholder evidence. A household is never stored as a member purchaser
override. Missing/deleted owners, guest owners, deleted accounts and household
other accounts remain guarded. A household loan books only a supported escrow
disbursement for property tax or homeowners insurance, with an unknown purchaser.
Loan payments and their matching checking entries are transfers that wait
for their transfer pair. Escrow interest is interest. An escrow refund uses the
original disbursement's category when identified; without a possible original,
it is income. Explicit
member choices and an existing Purchase's overrides and inherited
receipt/order/member evidence remain authoritative. Funding attribution remains
its own dated contract.

### Loan effective movement

`statementEffectiveMovement` is the one projection from a row's provider
amount, descriptor, source and resolved account to `{effectiveAmount,
movementClass, reviewReason}` in integer minor units. The financial statement
preview computes it once per row from the resolved live account and every
amount consumer reads that result: candidate discovery and direction, proposed
amount, candidate eligibility, merchant history, copies and pending matching,
kind votes, spending inputs, source-correction comparison, possible originals,
loan-payment evidence, transfer pairing and locked rebuilds. Observations keep
the provider amount, source identity and text unmodified, and fingerprints
record provider cents.

Outside a household loan the effective amount is the negated provider amount.
A household loan requires a unique source/account binding to that live loan;
a lender-looking merchant alone never makes a loan. For a recognized loan
class the sign follows the movement, independent of the provider's sign, using
the absolute amount. Classes are evaluated in this order on the trimmed,
case-folded descriptor with collapsed whitespace and anchored words:

- Escrow interest (`INTEREST ON ESC`, `ESCROW INTEREST`): −|amount|, interest.
- Escrow refund (`ESCROW REFUND`): −|amount|, a refund with a possible original,
  otherwise income.
- Payment (`PAYMENT`, `LOAN PAYMENT`, `MORTGAGE PAYMENT`, `PAYMENT RECEIVED`,
  `AUTOMATIC PAYMENT`, or exactly the account provider Vendor's name or alias
  with no refund, interest or disbursement terms): −|amount|, account transfer.
- Escrow disbursement (`PROPERTY TAX`, `COUNTY TAX`, `TAX DISBURSEMENT`,
  `HOMEOWNERS INSURANCE`, `HOMEOWNERS INSURANCE DISBURSEMENT`): +|amount|,
  purchase.
- Unknown (no class, contradictory classes, generic lender prose, generic
  refund, fees, unexplained withdrawals): the source-projected amount and a
  loan-movement review reason.

An escrow disbursement still needs an affirmative escrow answer and the
supported business guards. Unknown or contradictory loan movement stays in
review whatever the model kind or counterparty says; the sign is never booked
alone. A same-page refund waits for a tax original that appears later in input
order. Replaying a booked row compares against the effective amount, so a
provider-sign convention produces no correction; a changed magnitude does.

Ready-plan `purchaserId` is nullable. Approval snapshots include account
authority, dated access and holder evidence. Ready plans and direct booking
previews keep a separate `purchaserSnapshot` for replay validation of that
evidence even when both old and new individual purchaser values are null;
changed or absent proof requires fresh review. Older proposals without that
proof stay readable but cannot commit or replay as accepted ready plans.

Purchase inheritance and booking share the sole-access predicate; page previews
batch holder proof and commits recheck current holder and access evidence. When
settlement links an existing receipt, sole-card inheritance requires sole access
on both the receipt/order date and charge date (posted date fallback). A shared
charge therefore preserves known receipt-member evidence across different
dates; settlement never freezes that derived value into an override.

### Shared planner

Statement intake appends immutable source occurrences and observations. The
`bankEvent` reconciler owns the FinancialTransaction projection for one occurrence
or manual entry. It composes head selection, effective movement and kind policy,
and reads stored answers for its declared statement-kind ask. The `purchaseEvent`
reconciler owns one bank event's Purchases, Expenses, allocations and attributions.
It composes spending prerequisites, candidates, blockers, recorded splits, Vendor
selection, category selection and `statementBookingRows`; exact minor-unit
conservation is checked before apply.

Both reconcilers load every key of a batch together. The kernel reserves linked
identities, compares input revisions and applies records, dependencies and audit
rows as a bounded atomic batch. Natural keys preserve ids across replay. Baseline
bindings accept retained ledger records; disagreement produces drift and writes
no derived ledger changes. Member decisions override derivation and survive reruns.

Statement apply, attach, book, purchaser and Expense overrides, allocations,
splits and rejection record decisions through `decide`. Attach names a reviewed
transaction and records explicit identity; selected fields become assignments.
An ambiguous event stays unbooked until a same or distinct decision resolves it.
Waiting for order details remains a gap with a member booking action.

Direct finance commands and order/payment convergence use the same pure money
policies. Their reviewed correction, payment-match and transfer boundaries retain
their owning evidence and concurrency rules. Their ledger writes pass through
purchase-event evidence or decisions and the reconciler.

### Categories and Vendors

Clean new spending keeps the transaction-kind agreement, identity, ownership and
money checks. Missing, uncertain or conflicting category advice does not block
otherwise-supported booking: the aggregate Expense stays Uncategorized and its
missing effective category enters the shared Work queue. A booking's category
comes from a member's reviewed choice, a refund's identified original Purchase,
or the resolved Vendor's default category; otherwise the Expense is
Uncategorized. The model proposes no category per charge. Explicit reviewed
category choices still refuse deleted categories or unacknowledged conflicts.
Category history is optional and there is no amount cap.

The provider category stays verbatim evidence. Vendor name/alias resolution
runs first; an unresolved merchant may propose a supported cleaned business
name and keep the literal merchant alias. Person, processor-only, unsupported
and competing identities need review. Both names resolve again before a Vendor
and its booking are created atomically; one charge never establishes a
Vendor-wide spending default.

A merchant answer is keyed by the merchant key (`nameMatchKey` of the
merchant, else the raw description), the same function Vendor name and alias
matching use; descriptions sharing a key share one identity and support
answer. A supported high-confidence business identity whose proposed name
resolves to exactly one live Vendor, whose raw merchant string resolves to
none and whose allocation history is none or that same Vendor adds the raw
string as an alias through the Vendor entity update, appending to member
aliases. This is the bar that creates a new Vendor, and the same vetoes apply:
person, P2P and processor judgments, competing names, historical Vendors,
ambiguity and a merchant-history contradiction for that raw string. A new
Vendor is created only at its first booking. A member may explicitly choose an existing Vendor
and acknowledge conflicting category history while correcting a held booking.
Reviewed category and new business-name choices are kept separately from model
advice. Booking corrections use the server's retained advice and explicit
reviewed fields; clients cannot submit replacement model evidence.
Standard card-fee descriptions use the card account's live issuer Vendor;
the generic fee description is not a Vendor alias. A missing issuer needs review.

### Settling existing Purchases and refunds

Existing Purchase settlement reuses the retained-payment matcher: exact cents,
card/tender and owner evidence, the posting window, and a complete unique
conserved set. A wholly undated payment set stands at its order date; an
undated line beside a dated one stays bounded by the dated lines. Any other
unsettled order with an undated line of the charge's amount competes for it. The same
evidence checks apply to pending and observed charges;
status alone neither proves identity nor prevents settlement. Weaker
same-Vendor candidates within fourteen days, including tips, partial payments,
splits and combined charges, need review; amount/date coincidence alone does not
prove identity. One exception settles automatically: a positive purchase charge
whose only exact match is one unpaid same-Vendor receipt within three days, with
no retained payment evidence, open capacity equal to the charge, no older blocking spending, and no other
unbooked charge or Transaction for that amount within three days of the
receipt. That link is the same capacity-checked link a member would choose.
A complete retained-payment target, like that receipt, settles past weak nearby
candidates unless the member chose standalone spending; older review-only spending, or a candidate that another charge
already settles and that may be this same charge, still needs review.

Nearby candidates without explicit payment or member evidence require review
only when known remaining Purchase capacity can cover the charge, or capacity
is unknown. Settled Purchases and those with insufficient remaining capacity
remain visible as context and do not prevent automatic new spending.

For positive charges, actual nonfuture vendor Expenses on partly paid
same-Vendor Purchases outside that window or without dates also prevent
automatic new spending while their complete graphs have open or unknown
settlement capacity. Partly paid means at least one positive payment is
allocated and the charge-side vendor lines exceed the positive allocations, a
line is unknown or unclassified, or an allocated payment is not plain posted
settlement or is booked by a reimbursement line, as with installment plans and
payment schedules. Payments beyond the lines, as on a returned or recharged
order, leave no balance for a later charge. An undated retained payment line for
the exact charge amount also keeps an older Purchase as a blocker. Otherwise an older Purchase with no allocated payment does not block a
later charge.
These additional candidates are review-only: even a complete retained payment
set cannot make them automatic settlement targets. Only confidently zero
remaining capacity excludes an additional candidate. A nearby candidate is
excluded only when its capacity is confidently zero and every settling
Transaction is a provably different bank event: a posted amount other than this
posted charge's, or an acceptance from another provider ID in the
same provider scope or another position in the same collection, as an earlier
booking from the same feed creates. A manual, legacy, reviewed or cross-kind
settlement of the same amount may be this same charge and keeps blocking. Complete settlement targets, the
explicitly chosen Purchase, refund originals and Purchases whose retained
payment evidence names the charge's amount stay intact. Explicit member
selection or rejection keeps its authority. A header total without actual vendor lines is outside this
check, and exhausted capacity does not prove source-event identity.

Refunds require supported original-Purchase evidence independently of that
weak-candidate window. Besides retained refund evidence and member choice, one
same-Vendor order from the preceding 14 days whose open returned-line capacity
equals the refund identifies it, under the receipt exception's competing-evidence
check between that order and the refund. Reuse recorded negative Expenses before
creating a negative lump line. An identified original's single live effective category on
vendor spending, excluding future and reimbursement lines, supplies the refund
category unless a member explicitly chooses another. An unmatched refund needs
explicit review before a standalone refund Purchase is booked.

### Automatic booking

Supported statement spending reconciles without a Suggestion or review receipt.
The kernel audit records the input evidence, decisions, scope and rules revision.
Changing a derivation never overwrites a baseline or a member assignment. Rejection
is a durable decision; releasing it is explicit. Source identity and withdrawal
proof remain with the occurrence owner. Amount, category and transfer decisions
have separate authority and cannot substitute for one another.

## Mail evidence admission

Mail preparation validates source kind, owned original identity and exact
checksums before any paid attribution or relationship judgment. Admission
decisions cannot repair altered bytes; the writer repeats those checks and
requires roster membership inside its transaction.

Purchases store an extracted order id without its printed `<words> ID:`,
`number:` or `#` label (case kept), and order lookups compare ids normalized
(label, case, leading `#`), so one vendor's `Trip ID: X` and `x` reach one
Purchase; `No. X` without `:` or `#` keeps its words. An id-less source cannot converge by
order id. Its claim therefore lists existing-order candidates: Purchases linked
from other Emails in the same mailbox thread, and same-Vendor Purchases near
the Email date whose only line is an unitemized statement booking. Preparation
refuses an untargeted mail order while any candidate without a conflicting
order id (or a lump of its printed total) is not named in
`distinctFromPurchases`; the guard reads every candidate, not the claim's
bounded list. A targeted order is not checked against other candidates. Candidates select review; they never merge. A target
with identical lines replays as no change, different lines file a
reconciliation finding, and a statement lump of the same total files the
reviewed aggregate replacement. A Purchase merge refuses two Purchases with the same order identity that
each still hold lines; an order already imported twice converges through
`purchase_import.converge_duplicate_source_order`
([duplicates](../.agents/skills/purchase-import/references/duplicates.md)).

## Shipments

A Shipment is one package with optional Purchase association. Shipment writes
create no Expenses, settlement allocations or inventory receipts.

### Intake

Shipment intake shares `recordShipmentEvidence` across structured confirmation
extraction, linked `purchase_import.mail_resolve` package packets, and
standalone `shipments.record`. Import and reconciliation resolve a verified
retained Email to its public EML-code and the accepted Purchase to its PUR-code
inside their transaction. Attachment extraction also revalidates the retained
attachment checksum before recording its parent Email source. Tracking-page
intake keeps URL, stable external key, offset capture time and literal content.
Browser order extractions keep their package facts in the accepted extraction;
callers record a tracking capture explicitly through `shipments.record` when
they have the original page content.

Original shipment captures enter through the kernel's `append` as
`shipment.capture` evidence. The source-key/checksum constraint decides duplicate
intake; replay reads the retained capture without updating it. Capture row and
source keys index the evidence for reconcilers. Email captures discover the
Email's `emailState` scope, and evidence visibility belongs to the capturing
member. Package observations supply shipment identity separately from the raw
capture.

Email agents route package observations through `shipments.record` and use
`purchase_import.mail_resolve` for association/disposition; linked resolutions
can include per-Purchase packets atomically. The claim prepass settles the
cases the [Mail import rule](../apps/web/src/server/domains/purchase-import/service/README.md#mail-import-rule)
decides; every other notice reaches the agent for extraction (ADR 0011).
Historical retained-Email replay is a separately requested
`purchase_import.email_import` operation, never an implicit deployment job.

Interactive SMS export intake uses `source.kind: "sms_export"`, keeping the
literal message content, export filename, sender, message time with its known
precision/timezone, offset capture time and stable per-message external key.
The key is member-scoped and independent of export filename; replay keeps one
capture, while changed sender, message time or content under that key is
refused for review. This household's SMS timestamps use `America/Los_Angeles`
with the dated PST/PDT offset. Every new observation requires a calendar date.
When an SMS does not state a separate event time, use its notification date at
date-only precision; preserve forecast wording without asserting a completed
scan. Only explicit package identifiers establish a package; neighboring
messages, grouped delivery notices and opaque short links do not establish a
match. Keep unresolvable notices outside shipment intake until their package is
proven. Unattended Mail import cannot submit SMS exports.

Interactive scripts can use the CLI login and `cubby call shipment.record
--json-body '<JSON>'` to send the same evidence packets over the authenticated
HTTP API. Omit MCP's top-level `action` from the request body. Read back with
`cubby call shipment.timeline --json-body '{"shipmentId":"SHIP-4K7MN"}'`.
Reviewed corrections use `cubby call shipment.edit_observation --json-body
'<JSON>'` with the current observation ID from the timeline, Shipment reference
and a partial patch: the same ownership-checked, revision-preserving writer as
MCP. The CLI keeps its credential locally; scripts do not export or print it.

### Purpose and relevance

Shipment purpose is direction relative to the household: incoming, outgoing or
unknown. New SMS packages default to incoming; member eBay sales and purchased
postage labels (including Shippo) are outgoing. Explicit member
classifications use generic audited Shipment updates and survive evidence
replay. Replacement and return details stay in source evidence. Retained
extraction purpose text is immutable historical evidence: retired fulfillment
categories establish no direction, so their live package projection is
unknown. Extraction JSON, fingerprints and durable preparation receipts remain
unchanged.

Relevance routing keeps actual recipient parcel notices from vendors, carriers
and Shop even when no merchant, order, amount or Purchase is known; shipping
promotions and scanned-letter digests remain unrelated. Unmatched packages keep
their Email or page source with no invented Purchase. A Shipment source capture
protects its retained Email original from unrelated-mail disposal, including
when no Purchase association exists. A new trackingless package requires a
stable source package key and distinct-package evidence. Observations keep raw
status, location, source event keys and exact time precision/timezone. Use the
source notification's date when no separate event date is stated;
ingestion/capture time does not establish a historical event date. Label
creation and vendor-shipped reports do not establish carrier possession.
Repeated source observations use the shared writer's idempotent path; conflicts
remain evidence.

### Carriers

Carrier identity uses Vendor, preserving literal carrier wording and structured
handoff tracking pairs. Mail and Shipment share tracking-number normalization
and mail carrier recognition; carrier evidence still requires a bounded source
claim or tracking link. Carrier resolution uses ordinary Vendor identities
through unambiguous names and aliases; service wording stays in the source
evidence rather than creating another Vendor. Never create a Vendor from a
tracking-number prefix or mistake a merchant, broker or label platform for the
delivery carrier. Unknown names remain useful source evidence without inventing
a carrier identity.

A merchant `Delivery:` field holding a short uppercase code names no carrier:
one code can appear beside parcels of different carriers, so never alias it to
one. When that field is the code's only mention in the retained source, intake
clears matching carrier hints, including a stale Vendor reference, on the
package, extra references and new observation events. The value ends at its
line, a separator, a table column or a following tracking, carrier, order or
status label; other wording, as in `Delivery: ZQX Ground`, stays ordinary text.
Source keys, fingerprints and the capture keep the submitted wording, and a
re-extraction without the hint keeps the package's binding through its tracking
number. Another mention in the source leaves the code to the ordinary rules, so
a labeled carrier claim survives; a `Delivery: UPS` notice with no other UPS
mention stays unknown until other source evidence names the carrier.

The extractor's normal carrier fields populate a new or missing assignment.
Optional `carrierClaims` carry exact reference/name/service/role hints and
retained quotes or links. Evidence variants emit provider-compatible `anyOf` in
extraction output schemas. Intake also reads positive carrier/tracking
statements and independent links straight from retained source captures, so a
new receipt or proof index is not required to resolve a historical Shipment.

Clear package/reference-specific source attribution can correct a stored
carrier, regardless of who originally set it. A correction requires positive
attribution for the exact reference: a complete carrier/tracking statement,
carrier field or shipped-via statement with a labeled reference. Clipped,
conditional, negated or unrelated branding is insufficient, as are dates,
greetings and links laid out above a tracking label, which are not carrier
names and cannot create a conflict. Retained Email links must have an exact
reference on a supported carrier route; constructed tracking-page URLs,
lookalike hosts, unresolved redirects and multi-reference links do not
establish an assignment. Current link coverage is UPS `/track` and FedEx
`/fedextrack` or `/apps/fedextrack`. Image-only/PDF labels without retained text
remain available for review. Automated source correction uses the owning
Shipment writer rather than submitting unverified carrier edits through generic
CRUD. Carrier resolution has no machine/member ownership classification,
assignment receipts or audit markers.

Ordinary member edits use `entity.update` and its guarded bulk writer, commit
alongside other submitted fields, and appear in normal audit history. They do
not create a permanent automation lock; setting null leaves a missing carrier
that later source evidence may fill. An edit also drops extra references the
new primary covers, and the replaced carrier does not become a handoff. A
member can remove a false extra reference through `entity.update` with
`extraTrackingNumbers` patch items `{op: "remove", key: {trackingNumber,
carrierId}}`, so a stale client cannot drop a reference it never saw. A missing
key refuses the whole update, including submitted carrier and purpose changes.
The field has no replacement, add or bulk form, keeps the same lock and audit
history, and is refused for automation; an edit that changes nothing writes no
audit row. Source evidence that explicitly establishes a removed reference can
restore it.

Conflicting explicit source claims remain generic Problems because they may
represent a handoff. Read captures for primary and additional references,
including held/unbound captures, before first creation and later association.
Compare complete source-event periods within the inclusive 60-day rule. History
dates use current events naming the relevant reference, never another package in
the capture; claims without associated event dates remain conservative. HTML
link references participate in source discovery before exact-link validation.
Corrections keep the Shipment lock, revision fence and deferred identity
constraints, and never merge collisions.

Source-package bindings, occurrence identities and original fingerprints stay
unchanged. Replay recovers the binding from its reference when an alias changes
a fallback key, and from a source key respelled within that same source (case
and punctuation). The same label from another source stays separate, because
generic labels such as an origin state recur across unrelated orders. It
follows that package's current assignment unless the source establishes a
correction; an unsupported old guess cannot become an extra handoff reference.
Distinct known-carrier handoffs and original captures remain.

Carrier format checks stay as small code-owned rules matched against Vendor
names and aliases. They supply advisory context in source/identity review
findings, and never select or exclude a carrier, reject useful evidence or
reduce quality scores. The
[UPS tracking FAQ](https://www.ups.com/us/en/support/tracking-support)
explicitly includes 12-digit numbers, T/1Z/9-digit forms and freight/Mail
Innovations exceptions.
[FedEx Ship documentation](https://developer.fedex.com/api/en-us/catalog/ship/docs.html)
describes 12-digit references, longer barcode encodings and Ground Economy dual
identifiers. Twelve numeric digits therefore match both; unsupported format
means outside the small catalog, not invalid. There is no exhaustive catalog,
checksum rule set, regex database or live carrier lookup.

Carrier/identity findings reuse generic Problems: Shipment when known, Email
for owned mail, and the acting member LedgerParty for unresolved non-Email
sources. No speculative Shipment is created for a finding. Unlinked logins keep
sources and receive unresolved outcomes without a member-scoped finding.
Publication preserves dismissals for unchanged evidence. Reviewing older
carrier assignments is a read-only maintenance activity over retained sources,
not a carrier audit command or public operation; its reports stay private, and
it publishes no findings, replays no imports and applies no corrections.

### Timeline and quality

Shipment lists and details show First event, Last event, Event span and
Events. These read the reconciled, non-superseded tracking timeline; distinct
retained occurrences count even when their time is unknown, while clear
duplicate reports count once. Observation first/last-seen and capture times are
never endpoints. The span stops at the latest dated event, not the current time.
One dated event establishes both First event and Last event and has no span.
Dates display in the household timezone for exact events and keep the stated
day for date-only events. Date-only endpoints use whole household calendar
days; two exact endpoints use elapsed hours. Valid local timestamps establish
their literal calendar date, even when their timezone is unknown; they do not
establish exact elapsed hours. Unknown or unparseable stored times remain
readable but cannot be written as new event times. All four list columns sort
across the full population before pagination.

Shipment quality reads the same distinct, current event population and treats
valid local timestamps as calendar dates. Its weighted checks are multiple
events (10), carrier possession or movement evidence (30), explicit delivery
evidence (30), event span strictly greater than one day (10), known shipment and
delivery dates (10), and consistent chronology (10). Fewer than two distinct
events caps the score at 25. Label creation and vendor-shipped notices do not
prove carrier possession; in-transit, out-for-delivery and delivery attempts do.
Superseded observations and capture/first-seen times never fill gaps. Date-only
milestone evidence is sufficient. Delivery reports conflict when their known
time ranges do not overlap, or delivery is earlier than the first known carrier
movement. A date-only report covers its household calendar day, so an exact
delivery time within that day agrees. In-progress, same-day, cancelled and
returned records can remain incomplete under these evidence requirements.
Images, notes, Purchase association and source count do not affect this score.
Record quality, list quality sorts and filters share these checks.

Tracking reports show the source Email's received timestamp when the event time
is unknown, labeled as Email receipt rather than an observed event time; this
display fallback does not replace retained event time or enter milestone
duration calculations. Tracking pages cannot use notification-received dates:
only retained Email or SMS notification timestamps can support that fallback.
The reconciled history uses the shared records timeline and date formatter,
including relative age. Each row exposes its normalized event status alongside
the original source wording and links. Retained observations remain available
behind a collapsed, labeled records disclosure on web and native; formatting
never changes their timestamps. Shared report times distinguish instants (with
relative age), date-only values, literal local times with known or unknown
zone, and unknown event times with a separately labeled Email receipt fallback.
Every supporting Email and tracking-page source remains navigable.

### Package identity

Source package identity is kept separately from event versions. Identical
tracked packages across lifecycle Emails match normalized primary and
additional tracking references without requiring a Purchase or a known carrier.
Current, non-estimated source-event dates must fit one inclusive 60-day period.
Instants use the household calendar day; date-only and valid local clocks keep
their literal day. Import dates and cached summaries never establish identity. A
retained Email's received date or exported SMS's sent date supplies the identity
day when its observations have no non-estimated event date; this does not
change the observations, their provenance or delivery milestones. A tracking
reference can be reused after a gap greater than 60 days, but nearby evidence
cannot transitively extend an existing period past 60 days.

Conflicting known carriers, Purchases, multiple candidates, unknown event
dates and separate-package claims stay unresolved: intake keeps the literal
capture, returns `unresolvedPackages`, and publishes an Email review finding
when the source has an owned Email. It creates no speculative Shipment for that
packet. `distinctPackageEvidence` never bypasses tracked identity matching. A
new Email, item list or status change alone does not establish a separate
package. A source key is extractor text, so across sources it never establishes
identity alone.

A trackingless packet joins an existing Shipment only when both retained Email
originals link the same parcel on a bounded vendor route that names one
(Amazon's package tracker, by order, shipment and package index), both keys
name that parcel and respell each other, and exactly one live candidate fits
one identity period with no direction, member or Purchase conflict. Candidates
that do not fit are no rivals: a parcel id reused in a separate period joins
only that period's Shipment. Several that fit stay unresolved. No proof or no
fitting candidate stays separate; neither outcome refuses tracked siblings.

Equal item lists never prove a parcel: two boxes can hold identical lists, a
source can repeat its order's items, and Amazon can renumber one parcel between
its Shipped and Delivered notices. A fitting Shipment under the same order and
shipment, without exact link and key proof, whose notice links a single parcel
of that shipment and states the same item list of at least two distinct lines,
therefore holds the packet unresolved, even as the only candidate or beside an
exact match. Period, direction, member and Purchase filter candidates first. A
pair confirmed by other evidence, such as unique units on the order, is a
manual repair. Other lists, one line, grouped notices and another order stay
separate. Proof never comes from counters, origin labels, box numbers, order
numbers or other vendors' ids, however opaque, from tracking pages or SMS,
which keep no independent link, or from an unverified wrapper such as Amazon's
`/gp/f.html`.

Identical unkeyed source rows keep their multiplicity; replay updates the same
occurrences. A keyless identity hashes the submitted wording and carrier hints,
so a re-extraction of byte-identical source content can revise an occurrence:
exactly one unmatched observation and one unclaimed occurrence retained from
that capture must state the same kind, time, forecast status and tracking
reference, without conflicting places. The new version keeps the original
occurrence key beside its own fingerprint and supersedes the old version, whose
identity and fingerprint stay retained; a member-reviewed revision stays
current. Several same-day candidates, or new source content, stay separate
events: wording never proves that two reports are one. Rows that are already
duplicated stay as they are until an explicit correction. Native event keys
scope changed versions to their source package. A later A → B → A report keeps
a third version, while stale captures cannot replace a newer current version.
Every supporting capture keeps membership with its observations, including
unchanged events in changed page snapshots. Page content is kept and hashed
without trimming. Email captures keep their original content alongside the
verified Email reference and checksum.

### Constraints, merges and retirement

Deferred database constraints enforce nearby tracking uniqueness across
primary and additional references and validate the final current evidence
period. Writers share the shipment transaction lock; a single revision row
additionally forces stale snapshot transactions to retry. Existing duplicates
stay unchanged until explicit cleanup; new identity/reference or event changes
must satisfy the guard. Unrelated Purchase, purpose, notes and unchanged replay
updates remain available on such records. Undated references require review
before assigning another shipping period.

Consolidate Shipment duplicates before merging carrier Vendors, whose reference
rewrites must also satisfy identity enforcement. Confirmed duplicates are
merged as a group in one transaction, keeping the oldest record and retaining
notes, missing carrier identity, observations, capture memberships,
source-package bindings and member-reviewed Purchase decisions. Intake and
merges consolidate tracking references by normalized number and carrier
identity, ignoring carrier-label differences. Extras omit references already
covered by the primary number/carrier and unknown-carrier copies covered by a
known reference. Distinct known-carrier handoff references and original source
wording remain. Conflicting known directions or Purchase decisions require
correction first. Reassigning the last source package merges its empty former
Shipment into the target and inherits the same Purchase-decision and direction
preconditions. Old identities keep their merge destination; writes require the
current reference and the specialist timeline can follow the saved destination.

An interactive member can retire a source record that is not a physical parcel,
such as an empty template row, with generic Shipment deletion. Never merge such
a record into one real parcel. Its observations, capture memberships and source
binding stay on the retired identity. Replaying that binding reports the
package and restores nothing, while sibling packets in the source still apply.
A trackingless packet under a key that source has never bound is reported the
same way, because re-extraction can rename a retired template. A new source
naming a retired tracking reference starts a Shipment, since only that source's
binding records the decision. Explicitly naming a retired Shipment refuses the
whole record call; it does not restore the row. Keep real multi-parcel groups
when their observations cannot be assigned to individual parcels without losing
the group-level meaning.

### Purchase association

Explicit Purchase attachment or detachment is a reviewed decision that replay
cannot override. `shipments.reassign` moves an incorrectly associated source
package and its observations; later replay follows that corrected binding.
`shipments.merge` uses the shared Entity redirect registry, preserving the old
SHIP-code for reads while refusing writes through it. Carrier references in
structured extra tracking numbers follow Vendor merges, while source wording and
historical observations remain evidence.

The extraction schema accepts optional `allShipmentsDelivered` only to decode
previously accepted raw extractions without rewriting their literal evidence or
fingerprints. New model output requires structured `shipments`. No writer or
reconciliation action reads that boolean to create packages, mark an order
delivered, file receiving prompts or receive stock. Existing receiving findings
remain reviewable. A delivered package never establishes that all packages in
its Purchase were delivered.

## Financial mail convergence

`finance.converge` keeps its verified financial-mail convergence path. The
server rechecks posted transaction identity, stable provider references, live
account funding and exact Vendor identity. An existing Purchase requires an
accepted allocation or retained financial Email association plus its Purchase
link. A sole nearby amount/date candidate is advisory. Creating an orderless
aggregate requires genuine spending evidence; transfers, repayment, refunds,
reimbursements and incoming payments do not enter this path.

Financial identifiers are namespaced by provider. A copied payment ID alone
cannot connect an Email to a bank or Monarch record, even if amounts and labels
agree. Without a host-verified namespace, automatic reuse requires a current
member-accepted association for that exact Email, checksum, transaction and
reviewed account. This applies to financial-only evidence as well as booking;
otherwise keep the proposed association in review.

Replay compares accepted transaction, account, allocation, Purchase and full
Expense lineage. Changed accepted facts require review. Adding newly accepted
financial Email provenance refreshes the fingerprint only after the prior
accepted facts pass replay validation. Verified exact aggregate-to-itemized
replacement refreshes that lineage through the normal reconciliation writer.
Candidate ranking considers the full bounded set of 20 candidates, including
differing merchant names and dates, without granting automatic matching
authority. Split proposals preserve existing edges;
`finance.allocate_settlement` refuses a stale prior allocation graph. The
browser reopens settlement review with fresh candidates and their accepted
splits. Allocation writes use the catalog mutation's cache invalidation; the
dialog does not issue a second invalidation after the same accepted write.

A member-reviewed refund reference from an Email is an
`EmailFinancialAssociation`. It keeps the exact Email checksum, the original
account label, the reviewed account and decision provenance; it survives
deletion as history, exposes later account drift, and never writes financial
allocations. `purchase_import.mail_resolve` can link a lifecycle Email to
several existing Purchases through `purchaseIds`.

## Itemization and spending categories

SpendingCategory is independent of ProductCategory. Explicit Expense categories
win; Product Category mappings and eligible merchant context precede Purchase
fallbacks, as defined by [spending classification](spending-classification.md).
Category policies apply to the assigned category, without inheriting a parent
policy. An explicit `unknown` Purchase or transaction override also stops
fallback. Reviewed reimbursement purpose can support the original spending
category; a payment provider name or credit direction alone cannot. Suggestions
use saved linked Purchases, signed Expense lines and Products, and remain
proposals until reviewed. Native editors request the same backend inference:
policy and create-form choices change the draft; saved finance categories use
the audited atomic Apply command and preserve other unsaved edits.

Itemization expectation resolves from transaction/Purchase overrides, Vendor,
then spending category, and decides whether a Purchase should be itemized. A
Vendor's explicit value wins; otherwise its order evidence supplies it (an
online account expects item lines, no order evidence expects none), and
receipt-only or unrecorded evidence implies nothing, so the Vendor reads
Unclassified and its Purchases fall through to the spending category. A primary
document (receipt, invoice, order confirmation, sales order) makes itemization
expected whatever the policy. No policy requires a document: attachments are
optional evidence and never a gap.

Itemization is derived from the lines, not recorded: at least one live,
incurred principal `item_line`, no `allocation` line, and every principal line
whose Product is expected links one (services, tax, shipping, fees and
discounts never need one). A lone productless goods line is a lump. Unknown
category Product expectation also admits principal item lines to
Product-resolution and quantity research; it does not silently exempt them.
Explicit `not_expected` / `not_allowed` policies, services and allocations keep
their exemptions. Coverage keeps its three-valued policy status, and research
admission does not assign a spending category or copy a Vendor default: the
Expense category resolver reads the Vendor default live, and a stored copy
would outrank later Product Category mappings and profile changes. Stored
line quality follows rule changes through the stored-derived drain. Totals stay
with paperwork and settlement reconciliation. Itemization, Product resolution
and Expense booking have separate coverage; a charge is itemized only when every
Purchase it settles is. Itemization reads materialize only the requested
Purchase's live Expense rows, then apply each line fact's eligibility policy;
future and unclassified rows stay available to the facts that inspect them.

Gift and previously-owned Product provenance needs no purchase proof.

Free rewards and coupons reduce the incurred price: record a signed negative
Expense with `lineKind=discount`, its receipt description, and retained source
evidence. For example, gross $201.57 less a free $5 reward is $196.57 owed and
paid. Purchased gift cards or store credit are payment tender, not another
discount. Do not subtract a reward again when the receipt's line amounts or net
total already include it. Preserve literal stated receipt totals; correct a
total only when the receipt establishes that correction. Ambiguous reward or
tender evidence stays unresolved; never change an amount to force a match.

Vendor paperwork excludes reimbursement Expenses; net spend includes their
signed costs. Booking a vendor refund checks negative principal Expenses and
prior vendor settlements. Discounts cannot be reused as refund evidence. Partly
covered transactions require individual line review rather than silently
recording the full credit twice. Corrections can move an unchanged aggregate
reimbursement to its original Purchase or retire an unchanged aggregate and
attach its bank evidence to a reviewed transfer. Edited, itemized or
source-claimed lines require individual review.

## Settlement aging

Settlement queue work waits through two complete Monday–Friday days after its
start date, in America/Los_Angeles, without a holiday calendar. Friday evidence
is awaiting posting on Tuesday and becomes investigation work on Wednesday. The
grace ends at household midnight after the second following weekday;
calculating that deadline takes the same work for recent and historical
evidence. Use the effective transaction date, then Purchase date when no
transaction exists, then first observation (`createdAt`) only for undated
evidence. A reimport never resets dated age; an old dated record imported today
is already actionable. Recent Purchase settlement discrepancies and missing
settlement evidence from the declared unsettled view carry `awaiting_posting` in
reconciliation, fenced by source and tender authority; unmatched
account-transfer counterparts do too. Counts and kind filters use that state
before paging, while factual amounts and data-quality discrepancies remain
unchanged. Independent research gaps remain research. Aging calls for
investigation, never an inferred defect or permission to fabricate a missing
charge or transfer leg.

## Invoice-to-paid-order identity correction

A draft invoice and its completed order can name one economic event with
different identifiers. Original paperwork must establish that relationship;
matching amounts, dates or items alone cannot. The generic Purchase merge still
refuses distinct order identifiers: never clear or rename them to pass that
guard.

An explicitly authorized data-only correction uses the
[maintenance exception](agents/domain-rules.md#production-changes):

1. In one reviewed transaction, lock and fingerprint both Purchase graphs and
   their owned source families; account for every live line and payment and
   name each duplicate Expense's survivor.
2. Resolve classification, Project and attribution differences from
   provenance; an automatic import's defaults never replace an established
   member decision, and draft defaults never carry into the paid Purchase.
3. Transfer current source-order and line bindings atomically with retirement,
   through the declared edge policies, the Expense removal owner, merge
   finalization and the durable Entity redirect lifecycle. Keep source owners,
   keys, checksums, original extractions, observations, archived rows,
   documents, shipments, payments and member decisions; do not mark independent
   reconciliation findings resolved.
4. Rehearse the whole procedure in a rolled-back transaction, then apply it.
5. Verify the exact redundant spending and acquisition reduction, unchanged
   stock, surviving source bindings and unrelated records, with an independent
   post-commit read-back and an inert replay: the unchanged source must reach
   the survivor without recreating spending. Keep the audited identity decision
   and line mapping.

An uncertain commit requires read-back before retry. Missing ownership or
preservation guarantees leave the duplicate unresolved.

## Financial evidence entities

[Terminology](guide/terminology.md#naming-policy) owns the names; the
[README overview](../README.md#financial-evidence) owns the entity map. Source
transaction records and Transaction imports keep their generated list and
detail routes. Every bank record (`SourceTransactionRecord`) belongs to one
`SourceOccurrence`, its read-only judgment owner for current
account/disposition, selected record, withdrawal and nullable
`acceptedTransactionId`. Every owner represents one bank event within its
source: a `provider` owner by its Monarch transaction ID, a `positioned` owner
by its position in one collection, a `legacy` owner by its one record from
before positions were retained, and a `reviewed` owner by explicit review.
None needs a provider ID; Copilot, Mint, Apple Card and Monarch CSV rows never
carry one. Multiple independent occurrences, from any mix of sources, may
support one FinancialTransaction; one occurrence has at most one accepted
owner.

`finance.record` keeps immutable normalized observations. A Monarch row with a
provider transaction ID is that event (`provider:monarch` scope): one owner
per ID, whatever collection or export carried it. The provider account is
optional evidence; raw provider claims and accounts, when present, must agree,
and a disagreement holds the owner in `identity_conflict`. A bare `account`
string is Monarch's display label, not an account claim. Otherwise an
original collection fingerprint and positive physical position establish
collection-local identity. Neither account descriptors, resolved Cubby
accounts nor equal facts merge two owners. A new unpositioned request without
attestation refuses; a historical request can replay one uniquely retained
collection member without creating identity or money. Distinct identical
physical positions stay distinct.

Generic create/merge remain unavailable. Judgment edits resolve to the one
occurrence for every observation, including legacy records. Explicit source keys
select the union of exact external aliases and the named occurrence's current
observation through indexed identity reads. An external alias retains its
immutable observation's source; filtered selectors retain the full
observation-state policy. Observation notes
and exact reviewed replacement selections stay local. Preserved historical
annotations keep every original decision without copying it into new revisions.
A reviewed replacement names its exact retained observation, with an occurrence
FK when proven, and never copies accepted ownership. No alias-to-transaction
resolver or charge-key aggregation controls current state.

Source amounts store exact signed bigint minor units, with checked
dollar-number reads for shipped clients. `chargeKey` is always the judgment
owner's opaque `SOC-` handle. `STR-` still addresses the original bank record.
Find held groups through Source occurrence's `reviewState` (anything but
`ready`) and `supersededByOccurrenceIdPresenceFilter: none` filters; retired consolidated
reservations remain readable as history. A non-null owner never grants
financial authority. Original v1/v2/v3 references remain evidence aliases.
Fresh source acceptance uses an SOC handle and rechecks its ready state, head,
live target, exact amount and account. Earlier successful operation receipts
replay before fresh guards; uncommitted applications naming an older reference
require a new preview.

### Holds and identity resolution

Holds are for real contradictions, not missing proof. Intake joins a row to
its existing owner when the identity is exact: a Monarch provider ID joins the
one owner of that ID; a collection row whose original-reference alias matches
exactly one live owner in another collection of the same source, and occurs
once in the incoming collection, joins that owner as a re-export. Non-unique
matches stay separate owners, which booking pairs (see [Matching](#matching)).
A provider owner whose observations differ only in annotations (category,
notes, merchant, status) selects the latest observation as head; differing
amounts or dates leave no head in `revision_order_unknown`. Conflicting
provider claims or accounts hold the owner in `identity_conflict`; unresolved
direct history derives `ownership_conflict`. Original evidence and
actionable member review remain. `matchState: held` blocks automatic actions
for unresolved identity, historical ownership, or a retained accepted
reservation whose transaction was deleted. Summary splits `heldHistorical` from
`heldNeverMatched`; a hold without a historical link may still be unbooked
spending. `historicalTransactionIds` lists those retained links explicitly; it
never supplies accepted ownership.

SourceRecord updates accept `identityResolution` only as an explicit reviewed
judgment, with `expectedDisposition`, the observation fingerprint, expected
owner version, accepted owner, complete live historical transaction set,
resolved account, explicit open/ignored judgment and note. Choose `distinct`,
`accept_existing` or `assign`. The transaction is audited and preserves explicit
ignore decisions and original aliases.

- `distinct` confirms a held owner as its own event; `accept_existing`
  accepts its exact existing Transaction.
- `assign` consolidates a complete eligible legacy, positioned or reviewed
  owner into a provider owner, keeping the provider's selected record and
  transaction contents. Both versions, reviewed facts/history, account, amount
  and financial judgments must agree. Conflicting direct historical
  transactions or provider IDs refuse; another owner's exact replacement
  reference must be resolved first. An accepted link may transfer after
  explicit review. Retirement clears the old head and accepted link, keeps its
  identity reservation and audited preimage, and records released acceptance as
  tombstoned evidence. Intake follows one consolidation reservation directly to
  its provider survivor; ordinary replacement edges do not redirect intake.
  Remaining overlaps keep the provider held. Bulk moves to one target must
  reread its version between commands. The survivor keeps the latest
  observation time across both groups.

Deleting the last live record of a legacy group retires that group while
keeping its original decisions and evidence. See
[source identity review](#source-identity-review) for the reviewed batch path.

### Suggestions on source records

Financial suggestion dismissal applies to the exact current recommendation
fingerprint or unchanged evidence fingerprint. Label-only revisions preserve the
dismissal; changed evidence or recommendation policy may produce new advice.
Retired suggestions and aliases never propagate dismissal to another bank
event. Explicit financial ignore decisions remain authoritative; presentation
feedback is not an ignore. Exact import replay never submits an identity or
financial judgment.

Suggestion record reach is declared per family with explicit affected roles and
forward/reverse SQL. Statement reach starts at its primary bank record, follows
occurrence siblings and collection memberships, and does not depend on a stored
charge-key string. One and many-record badges use the same bounded record
expansion. Work keeps the narrower account-owned statement reach.

### Reads and deletion

Source record list, detail and display-media reads are projections in one
statement snapshot: computed row values keep their raw timestamp and minor-unit
money decoders, page bindings follow exactly one sibling hop (including siblings
outside the page and retained alias tombstones), and the occurrence ownership
fence reads its direct aliases separately, so a fence-only occurrence cannot
disappear from the page. Historical links remain presentation and negative
ownership fences, never accepted ownership. Filters, sorts and whole-population
membership keep their declared scalar SQL, and whole-list projections
materialize retained historical closure before applying root predicates. The
non-unique alias lookup index keys `(source, value)` across kinds and
tombstones; provenance and ownership uniqueness remain separate constraints.

Transaction imports are read-only outside intake. Neither generic create,
update, merge nor delete changes their metadata or membership. Intake owns
resumption, count/completion updates and source-confirmed withdrawal; deleting
a collection is not a reconciliation operation.

Generic deletion of a source transaction record blocks while a live predecessor
supersedes to it or an accepted FinancialTransaction source reference claims
it. It preserves those relationships rather than detaching or cascading
evidence. Resolve the accepted relationship through its owning workflow before
retrying; a withdrawal is recorded evidence and never an instruction to delete
history. Deleting a current revision does not promote an older one; replaying
an older import still respects the deleted head's observation time.

Use `entity_read.get`, `entity_read.list` and `entity_read.search` for records,
imports and their declared projections; use generic entity commands for
judgment updates and guarded deletes. The specialized summary and drift reads
remain workflow computations. `record` owns intake and `previewSuggestion` owns
the read-only review projection.

`entity_read.list` exposes exact stored-value filters for `chargeKey`,
`providerTransactionId` and `providerAccountId`. Each accepts one value or an
any-of list; different filters intersect with the `source` filter. Use the
provider transaction ID alone for Monarch: one ID is one charge. The `current`
boolean selects current (`true`) or historical (`false`) observations; omitting
it returns both. Generic lists still exclude soft-deleted observations,
including deleted heads; they do not promote an older revision or prove
complete retained history. These filters select evidence and grant no
identity-resolution or financial-admission authority.

`finance_read.drift` reports possible overlap between distinct charge keys, not
proven duplicate money. Equal source/account/date/amount fields and row creation
order cannot establish occurrence identity or revision direction. Its default
shared-membership exclusion preserves normal export coexistence; historical
mixed membership still needs source proof. Inspect retained provider
identities, revisions, collection memberships and accepted settlement
references before guarded reconciliation. Truncation and an empty candidate
list do not prove historical completeness. The read grants no bulk supersession
authority.

## Normalized financial evidence intake

Claude/Codex use the [financial-evidence-import skill](../.agents/skills/financial-evidence-import/SKILL.md)
to read Monarch MCP or parse Monarch, Mint, Copilot and Apple Card exports
locally. Cubby accepts normalized observations through `finance.record`; the
application has no financial CSV parser, upload, mapping, preview/commit,
native file picker or CSV CLI. USDA parsing and expense report exports are
independent of financial intake.

MCP server guidance routes financial evidence through this intake and the
financial-evidence-import playbook. Recording evidence delegates downstream
matching, Suggestions and guarded booking to Cubby; a client does not follow
intake with a separate transaction-create, attach or Expense-booking sequence.
Collection runs through the local skill with the member's connected Monarch and
Cubby MCP tools; it does not require a Worker-owned Monarch connection. Any
recurring execution uses that same skill on an explicitly authorized host with
verified credentials, after historical reconciliation; the skill installs no
scheduler.

### Observations and revisions

Keep every observation and original description. Reobserving equal normalized
facts under a proven identity can reuse their observation and first
providerData annotation while adding collection membership. Each new membership
freezes a request fingerprint, so exact replay cannot rewrite that collection's
input. Unknown positions/fingerprints stay null; never infer ordinals across
imports. Fact/request hashes establish equality only, never event identity.

A changed normalized fact appends an observation. Arrival time, current flags,
lexical codes and collection timestamps cannot prove provider revision order.
Unknown ordering leaves the occurrence without a selected head and blocks
automatic actions. Explicit reviewed version selection can resolve that hold;
it does not move accepted money. Older collection replay never advances a head.
Zero observations remain evidence and cannot create spending.

Cross-collection positioned overlap stays independent and held when retained
evidence makes its economic identity uncertain. Aliases may widen candidates or block unsafe
automatic work; they never establish accepted ownership. Complete retained
bindings, including tombstones, must support any ownership promotion.

Provider account masks keep all supplied digits, including non-card masks
longer than four digits. An account name already containing that mask does not
receive a second suffix. These descriptors participate in statement identity;
normalization must not truncate them into a different account reference.
Stored descriptor spelling and reference strings remain. A changed descriptor
is not grounds to rewrite accepted transaction identity or an old observation.

### Acceptance and corrections

Acceptance and ordinary financial edits reserve command keys, then lock sorted
occurrences before settlement-party, Purchase, FinancialTransaction and Expense
rows. The source owner and money effects commit together. Graph expansion or
stale review refuses/retries the DB-only snapshot; model calls stay outside.
Successful receipts precede these fresh checks. A deleted accepted transaction
keeps its source reservation and cannot be recreated by replay.

Corrections read the explicit accepted FK and independently corroborating
occurrences. Unresolved historical bindings remain negative blockers. There is
no observation → alias owner → transaction account → copied source judgment
loop. Member suppression is read from its Suggestion owner, without copying
another current decision ledger into the occurrence.

Cubby reconciles accepted revisions in one snapshot transaction. An automatic
amount correction or withdrawal requires the original automatic-decision and
Expense-lineage fingerprints, one unchanged generated lump, unchanged
allocation and member shares, no itemization, claims or attached independent
evidence, and current corroboration that agrees. Amount corrections update the
transaction, allocation and Expense together. Withdrawal retires the generated
Expense through supported writers, voids the transaction and keeps references
and history. Edited, itemized or conflicting bookings stay in the Suggestions
queue for individual FinancialTransaction/Expense review; recording source
changes never silently overwrites them. A source date revision that changes the
booking's effective funding date requires individual review of dated
allocations and Expenses. Status/date-only refusals remain durable Suggestions
even when the amount is unchanged; supported posting updates may proceed when
the effective funding date stays unchanged. Current evidence that already
agrees with the booked amount and lifecycle needs no write and opens no review,
whatever the booking's decision provenance.

### Collections and withdrawal

A collection owns its immutable observation time, declared count and optional
account/date/visibility scope. Chunks resume that collection. Membership is
independent of first ownership, and known memberships are never widened into
invented complete historical windows. Completing a source pull requires
exhaustive enumeration and equality between declared and retained counts,
including zeros. A page or visible-only query cannot establish absence. The
skill must identify unsupported accounts, including Monarch connections
excluded by its MCP, rather than reporting them current.

Evidence, memberships, revisions and the statement Sweep's Pass intent commit in
one transaction; waking happens after commit. Corrections recheck the automatic
spending switch under its transaction lock; pausing it blocks money changes and
retirement as well as new booking. Scheduling failure rolls admission back. The
outer DB-only snapshot write uses bounded retries for serialization conflicts,
including late derived-refresh claim contention, rebuilding evidence and Sweep
admission together on each attempt. Dry runs and unchanged replays create no
Runs, Jobs, Suggestions or money; Jobs own interrupted execution recovery. A
new collection can advance observation time without changing the original
source record; `refreshed` counts those new observations of known facts.
Completed collections reject additional membership. A reappearing withdrawn
charge stays in review rather than silently recreating retired spending. After
verified historical backfill, routine Monarch pulls overlap two weeks; refresh
older windows deliberately when needed. Collection rosters return metadata
without bulk-loading retained source notes or archives, and recording retries
read only the immutable collection header.

Source-confirmed withdrawals require a completed all-visibility account/window
and an explicit recheck. The occurrence records withdrawal and its proof
collection. Old observations cannot reactivate it; reappearance remains held. A
later-dated export alone never proves disappearance.

### Matching

Suggestions remain one per actionable charge. Matching a source observation is
separate from booking Expenses. Existing candidates must be rejected before a
new transaction can be created. Historical collection membership may include
surplus or mispositioned evidence; it cannot by itself dismiss a settlement
candidate during Suggestions discovery, and ambiguous identity remains review
work before new spending. A nearby transaction (same account, ±3 days) is a
candidate only for the same amount, a matching non-empty description or a
matching non-empty merchant; two missing descriptions are absent evidence, not
a match. Descriptor/amount/date coincidence is advisory; a different source's
observation does not become a second charge merely because its text differs.
The clean-booking rule keeps its own authority and revalidates current
evidence before writing; an attach waits for review unless it is a copy's
paired attach.

A bank event may reach Cubby through any combination of sources (Monarch CSV,
Monarch provider pulls, Copilot, Mint, Apple Card); each source keeps its own
occurrence and every one of them settles the same Transaction. Copies are the
live charges from any source on one resolved account, at the exact amount,
within ±3 days, booked or not. When every source in that group holds the same
number of charges, the k-th charge of each source (by statement date, then
recording time) is one event. One primary per event books it: a provider row
before a collection row before a legacy record, then the earliest recorded.
Transactions its own source's other charges already settle are not its
candidates. The other copies publish nothing until the primary books, then
attach to its Transaction; that paired attach is clean without a model label
when the Transaction is an exact-amount candidate no other charge of the same
source claims. Booking a primary refreshes every charge in its group. Unequal
counts cannot tell repeat charges from copies: every member keeps the others
as `siblings` and waits for review.

Within one source, an export without provider IDs can re-record provider rows.
Before a statement page publishes, a group of live charges with identical
resolved account, descriptor, date, amounts, description and merchant is
settled automatically when every member is ready and unbooked, its provider-ID
rows and ID-less rows come from different imports, and the two counts are
equal: each ID-less row is superseded by a provider row through the reviewed
replacement writer under intake's source lock, and its advice retires in the
same transaction. An occurrence whose replacement anyone already set or
cleared is never superseded automatically. Any other group keeps its
`siblings`.

### Statement Sweeps

Recording rows starts a routine statement Sweep; `run.sweep` reruns it. Default
background labeling is unscoped.

**Stored answers.** Each model question is asked once per distinct input. A
statement Suggestion stores `data.answers` per question (kind, counterparty,
each candidate, escrow, merchant) as `{value, input, versions, models}`, where
`input` is that question's exact projected input and `versions` the feature
prompt versions that produced it. A later pass reuses an answer when its input
and versions equal the current ones, reading the charge's slot rows and prior
publications through observation identity and aliases, newest first, per
question. A completed abstention is an answer; a failed or unavailable call is
not and stays a retained item failure. Reuse is per question, so a changed
candidate re-asks only its own label. Answers never enter either hash. The AI
response cache holds every completed answer, so a missing stored answer usually
refills from it without a provider call. An unchanged repeat pass makes no
model call, publication insert or answer write.

A statement amount reaching a question is the effective movement. Escrow and
merchant answers come from spending advice: merchant identity and support
inputs use the merchant key, and the escrow input carries the merchant,
description, source category and effective amount. A stored answer saves under
the charge's advisory lock to the active slot row; if the charge moved, the
write is dropped.

**Fingerprints and dismissals.** Two hashes keep their meanings: the rule
evidence hash and the labelled output hash. The rule evidence payload carries
the frozen hash-scheme tag `{revision, cleanPolicy}`, which changes only with
the serialized payload shape. The labelled hash excludes the spending judgment,
so a Vendor or alias edit neither reopens a dismissal nor republishes. A revision-scoped dismissal holds
while both hashes are equal, so a policy-only change keeps it; changed rule
evidence or changed labelled output reopens the charge. A permanent "Never
suggest" holds separately. The automatic policy revision is separate from the
hash scheme: an unchanged row whose matched rules differ under the current
policy is restamped in place under its lock and never republished, and an
active pending row's stamp must match the live policy to apply.

**Pages.** Generation and labeling commit bounded pages of independent charges;
[statement pages](jobs.md#statement-pages) owns the page sizes and the
cooperative page budget. Generation is a scan: charges that need a label,
member review, no action, a hold or are out of scope do not bar a later ready
charge. Labeling asks only unanswered applicable questions, saves each paid
answer before publication, and hands the charges to the shared
publish-and-settle path that generation and retries use. Identity questions
stay batched; merchant/spending preparation runs in waves of
`STATEMENT_SPENDING_CONCURRENCY`, with field questions batched within each
wave, and a single page allowance admits fresh context-fitting questions in
identity/kind/counterparty/spending order, reserving spending before the next
charge. Stored answers stay usable after the allowance is exhausted. Untouched
charges keep their complete candidate population and inclusive cursor; they
receive no skipped outcome or completion. When the page budget ends, a page
settles started work and saves answered questions before yielding; it does not
interrupt an in-flight provider request. Cache contention and lookup deferrals
remain typed waits, neither retained item failures nor triggers for uncached
model calls. Failed items remain unresolved even after scanning ends: a
completed scan with retained failures is not completed reconciliation. Page
caches are discarded after their page: label work, publication and financial
application rebuild current facts, and a commit never uses a page cache as
validation. These bounds limit repeated work after interruption; they are no
wall-time guarantee.

**Publication and settlement.** Every Sweep, scoped or not, settles every
eligible statement row: an active pending row whose current stamp matches the
live automatic policy, whose source is eligible, whose kind and clean status
agree and whose scope admits it. Import scope narrows what a pass admits; it is
not what makes a row eligible. A Sweep that completes leaves no eligible row
unapplied; commit refusals, member-review rows and Uncategorized bookings are
counted, never hidden. Publication carries each charge's Suggestion receipt and
original application order. A failed batch reconciles each charge through the
same locked admission path: committed publications recover their pending
application receipts before testing the obsolete input fence, and finish
retirement before acknowledgement; recovery does not recreate or restamp
labels. Resumed application receipts repeat that exact retirement check before
application, including recovery from a crash before the after-commit callback
started. Automatic financial application admits only the original ready prefix.
Generation and label pages apply compatible creates through the same guarded
transactions of at most 32, one dependency layer each
([statement pages](jobs.md#statement-pages)). Each rebuilds current evidence
under its locks and preserves per-charge receipts; declined items use single
admission, and a row whose Suggestion moved is re-found by charge before it is
applied. A booked primary's copies come from other sources, so no import scope
admits them; the neighbour refresh republishes their paired attach for the pass
that owns them. Before any application on a generation page, its own rule
selection decides which charges need admission. An as-is attach uses its proven
paired Transaction even beside other candidates; an unpaired ambiguous attach
requires an explicit target. Preview, stale-term comparison, spending
preparation and application use that same target. Charges already skipped by
the current label page do not split that prefix; failed, unfinished and
applicable-rule charges stop it. Unscoped passes may complete consecutive
no-action receipts in bounded transactions: lock the exact receipts, verify
their charge/evidence, active pending state and absent rule descriptors, then
clear only the proven prefix through the projection writer. A missing, replaced
or rule-bearing receipt stops the batch. Single-item admissions regenerate
first once the page has written, since regeneration can introduce actionable
rules, and the page's charges a write affects are republished together before
their admission. A failed proposal build bisects so failures retain their own
references. Statement application and booking request only identity output from
their mutation writers when they consume only IDs; the writers keep validation,
locks, audits, allocations and receipts.

**Retries.** Retrying failed statement labels consumes only the retained charge
references, one charge at a time, without moving the original population
cursor. Each charge is regenerated under the Run's retained account/date/import
scope before its current label work is selected. Model waits and funding pauses
keep that charge; disabled automatic AI work pauses the retry rather than
discarding it. Healthy charges and later arrivals are not added to the retry
population. An obsolete Pass generation or claim interrupts the invocation;
per-charge error isolation must not turn that ownership signal into an item
failure or retry.

**Scope.** A statement Sweep carries its full account/date/import scope
through hold counting, paging, input inspection, label counting, selection,
retries and receipt admission. Hold selection intersects the account filter
with retained charge membership/date before cursor limits; it admits whole
holds and keeps every pending settlement reference's evidence. Explicit
withdrawal proof is still required for a void proposal; incomplete membership
supplies none. Date and import filters intersect on retained source
observations, including withdrawal imports; the date is the source
`statementDate`, not the Suggestion timestamp. Account scope uses live
generation-preview resolution, including stored and accepted-settlement hints;
void targets use their live transaction's account. Scope follows regeneration
and is checked again inside automatic review's serializable write admission,
and scoped answer saves, label publications and receipt completions recheck the
live resolver inside their write transactions, so valid fresh evidence for
another account cannot authorize an effect. An out-of-scope result keeps
evidence and stored answers without publishing or acknowledging that target;
excluded receipts keep `applicationPending` and their original
`applicationOrder`, and completion counts include only IDs the writer admitted.

`run.sweep` and its estimate accept a statement family's optional `importId` as
a TransactionImport shortcode (`TIM-…`). Both resolve the live retained
collection before estimation or Run/Pass creation; invalid, missing and deleted
references refuse. Account and date filters intersect its retained charge
membership. Selected charges still use current observations from other
collections sharing their identity; unrelated charge identities stay excluded.
This reprocesses retained evidence under the automatic policies, including
clean spending booking. An empty or unscoped Sweep does not admit held or
ambiguous sources, and attachments wait for review. Incomplete collections
allow supported positive processing but prove no absence, withdrawal,
reconciliation or completion. A Sweep changes neither collection coverage nor
`completedAt` and records no withdrawals.

**Logs.** RunStep page samples keep selection, discovery, label preparation,
decision, spending-fact, spending, publication and ordered-application wall
times plus database metrics; ordered application includes no-action prefix
validation and receipt settlement and must not be mistaken for model latency.
Generation logs separate selection, preparation, publication and
import-application durations with aggregate counts, without source records.

### Unlinked spending and ownership exits

An unlinked principal vendor Expense for a selected Product requires explicit
source reconciliation before new itemization. A zero-cost entry with negative
Product quantity records an ownership exit rather than an acquisition; it does
not by itself block a later purchase. Preserve that disposal's quantity, date,
notes and unlinked state while importing the new order's own spending. Unknown
cost or quantity and all other unlinked entries keep the review guard. Neither
this distinction nor receipt import receives stock or reuses the disposal.

### Foreign receipt itemization with USD accounting

A complete non-USD purchase keeps its literal currency, descriptions, amounts,
quantities and adjustments in accepted source evidence. Its ordinary item-line
Expenses carry `cost: null`, supported quantities and editable Product
bindings. `ImportSourceProduct.expenseId` gives each original line its
canonical acquisition; no separate item entity is needed. Shipping and
adjustments never acquire Products. An absent quantity stays unknown. Product
history can show an acquisition with unknown USD item cost; neither its cost nor
quantity enters USD pricing averages.

A separately supported USD aggregate remains the only booked amount. Source
amounts never enter `Expense.costMinor`, USD payment evidence or USD sums. Exact
foreign source itemization is present independently of Product resolution;
booking is recorded when the USD aggregate covers the purchase, while USD item
valuation stays unknown. Unresolved ordinary USD costs still make booking
partial. Original order and statement dates keep their respective owners.
Import and reconciliation never receive inventory. Earned but unspent rewards
are neither tender nor a discount.

Replay reuses immutable source-line references. Equivalent sources reuse the
whole unpriced roster only when their literal currency, total, ordered lines,
amounts and quantities agree; repeated identical lines use their Expense
references. A new foreign source beside pre-existing priced item Expenses, an
ambiguous roster or changed accepted facts requires review rather than another
acquisition. Ordinary Expense Product edits and Product merges keep canonical
Expense identity and original source history. Accepted-source Product-only
attachment can bind an existing item Expense without comparing foreign amounts
to USD; it cannot bind an aggregate or change money. Missing original lines
require a reviewed maintenance repair, not a replay that silently changes
accepted data.

Pricing a foreign item through ordinary Expense update is refused. This
protection follows its retained source binding even if its Purchase or
classification changes; coverage separately requires the current Purchase and
item role to agree. Later actual USD itemization uses reviewed source
reconciliation: review the complete unpriced roster together with its USD
aggregate, reuse each acquisition once, preserve item identity and supported
quantities, remove the aggregate, and conserve recorded USD spend and
attribution in one transaction. Source-claimed aggregates keep their explicit
financial correction requirements. Original foreign bindings remain on the
reused Expenses, including when revised USD evidence uses the same source
identity; changed monetary fingerprints cannot erase the reviewed
correspondence; no exchange rate or per-item USD allocation is inferred.
Foreign refunds and cancellations remain reviewed accounting work. Native
foreign balances, optional USD allocations and automatic stock changes are
unsupported.

### Total-only USD confirmations

A USD order Email that prints its grand total and item names but no item
prices is extracted as `needs_review` with reason `unpriced_itemization`: each
printed item is a line with `amount: null`. Unpriced lines are valid only under
that reason, which requires USD and a printed total; `sum_mismatch` remains the
reason for printed item amounts that disagree with the total and still files
its review finding. The ordinary Mail import tool and the writer accept
`unpriced_itemization` without a finding: the Purchase header takes the order
number, date and printed total, one `allocation` Expense carries the total, and
each item becomes an item-line Expense with `cost: null`, its supported
quantity and its own Product resolution. No item is priced from the total.

The unpriced lines follow the foreign roster rules above. Their source binding
marks them as covered by the aggregate, so settlement, booking coverage and
reconciliation sums count the aggregate alone, and ordinary Expense updates
cannot price them. Retained payment evidence settles a statement charge
against the aggregate. Later
priced evidence for the same order reaches the same Purchase by Vendor and
order number and goes through reviewed source reconciliation, which replaces
the aggregate and reuses each unpriced acquisition once. The unpriced-line
data-quality gap stays visible until then.

### Purchases waiting for order details

A Vendor's shipping or delivery notice that prints one order number, when no
live Purchase at that Vendor holds it, creates that order's empty Purchase:
Vendor, order number, the member's only account at that Vendor, and the
notice's household day, with no Expense, payment, money or stock. The Mail
import claim creates it and links the notice (`linked`, its lifecycle event)
and the notice's recognised package to it in one transaction; a refused link
leaves no Purchase. The marker is derived, not stored: no live Expense, no
accepted import source, and an active link from a shipping or delivery Email.
While it holds, the Purchase's ledger and settlement checks (`empty_expenses`,
`stated_total`, `purchase_itemization`, `settlement_reference`) are not
applicable rather than gaps, so it files no queue item. With no Expense it
adds nothing to spending and cannot absorb a statement charge's capacity.

The order's confirmation imports onto that Purchase through the ordinary
order-number target, never as a second Purchase: an empty Purchase without an
accepted source is not already imported. Its order date replaces the notice's
day; header facts the notice left empty fill in, and its lines, aggregate and
payments are written as for any new order.

### Correcting a purchased Product

Correct an imported item's Product through the ordinary Expense entity update.
Create a missing Product through the ordinary Product create first, then set
`Expense.productId` and the purchased quantity. No accepted-source lookup,
original preparation or reconciliation command is required for this correction.
The live Expense owns the current Product. A retained receipt-line reference
lets identifier discovery follow that Product, including reassignments and
clearing the Product; original import Product decisions remain history. Deleted
Expenses and Purchases do not contribute receipt-derived identifiers. An
incomplete order with no Expense keeps identifier discovery through its current
generic Purchase/Product association; removing that association removes the
claim without inventing money. Imports record the Expense reference even when a
Product is unresolved; ambiguous original lines stay unlinked. Financial
reconciliation keeps its review and conservation checks.

Retailer preparation can explicitly target an orderless Purchase. Receipt
itemization that changes recorded lines proposes `reconcile_source_order`
before accepting its headers, attachments, Product bindings or payments. The
writer carries one locked line-admission decision and Expense snapshot through
ordinary line writes; a new Purchase is admitted from an empty snapshot. The
source-reconciliation review owns replacement proposals with original lines,
proposed identities and exact beneficiary/funder amounts. Approval binds the
full proposal and original graph; changed proposals or edited originals fail.
Stored `replace_aggregate_line` approvals remain applicable through their
reviewed-snapshot consumer. Photo groups remain editable and require approval
before Product and inventory writes. Imported source claims alone do not
establish reviewed itemization.

Prepared candidate reviews preserve their original evidence. New preparations
record exact name/alias equality explicitly; candidates that never recorded
that judgment expose `exactNameMatch: null`, rather than a fabricated non-match
or a reconstruction from today's catalog. Reading a review does not rewrite its
saved snapshot; commit independently rechecks current identities. An unchanged
accepted item identity replays even when its original resolution was `new`,
when money is incomplete, or after its Product merges. A changed choice or
missing accepted binding requires reconciliation review. Equivalent second
sources keep their observations without duplicating canonical Product
association rows; binding an unbound manual item creates the association once.
Identifier-collision review proposals publish after the import has kept its
Product bindings and finished learning identifiers, so those evidence writes
cannot supersede a fresh proposal before commit. The registered identifier
remains with its actual owner. Recorded purchase-import commit results default a
missing `requiresReview` flag to false; malformed values fail validation.

## Money representation

Settled money is stored as signed exact minor units (bigint): source amounts,
`PurchasePaymentEvidence.amountMinor` (signed USD, including original zero
lines, which are neither discarded nor merged),
`FinancialTransactionAllocation.amountMinor` (signed, nonzero), FinancialTransaction
amounts, Purchase `statedTotalMinor` (nullable) and Expense `costMinor`
(nullable, signed USD). Sums, keys, conservation, merging and direct
comparisons use minor units. Native, MCP, entity and audit wires,
purchase-import and spending boundaries, and retained fingerprints keep dollar
numbers (`amount`, `statedTotal`, `cost`), including the frozen
reconciliation fingerprint shape. Source extracts and successful receipts are
never rewritten. Expense writers accept a dollar value only when it resolves to
a whole cent within binary float tolerance and refuse anything else. Foreign
amounts stay in source evidence; Expense accounting is USD. Preimages of
converted money tables are retained in the `archive` schema.

SQL money projections share `server/db/computed/money.ts`, with explicit numeric
or float8 result types. Raw SQL dollar fields entering retained JavaScript
fingerprints, including embedded transaction JSON, must use the PostgreSQL
float8 driver boundary or an explicit decoder; an `execute<T>` annotation does
not decode numeric strings. Retained float-sum fingerprints keep their per-row
float8 accumulation, and SQL-hashed JSON/text boundaries keep the float8
representation rather than numeric scale; authoritative conservation and writes
use minor units.

## Validation boundaries

The [Mac import runner](../apps/web/tooling/mac-import-e2e.md) exercises native
capture, photo approval and product import end to end.

## Reviewing statement outcomes

Source transaction records browse immutable observations; Transaction imports
browse retained collections. Each import's reconciliation report separates
observation match states from booking coverage for distinct FinancialTransactions.
Collection membership follows charge identity across revisions. Overlapping
collections are not additive, and booking proves neither source completeness nor
itemization.

A record's machinery exposes its gaps, evidence, decisions and drift. Apply the
current observation with `sourceTransactionRecord.apply` (MCP `finance.apply`):
create, attach, supersede, void, book or reject. An attach names the reviewed
FinancialTransaction; selected transaction columns become assignments. Purchaser,
Vendor, category and booking choices become purchase-event decisions. Ambiguous
identity requires an explicit same or distinct decision. A missing order leaves
a waiting gap with an explicit book action.

Retained baseline bindings accept existing FinancialTransactions, Purchases,
Expenses, allocations and attributions. Derivation that disagrees reports drift
without ledger writes. Member assignments and rejections survive replay. Review
source holds and withdrawal proof before changing identity or movement; a new
answer or a successful replay cannot override a member decision.

The [statement backlog workflow](../.agents/skills/financial-evidence-import/references/statement-backlog.md)
owns the agent's review sequence. Direct finance previews retain their reviewed
fingerprints and lineage contracts.

Direct booking previews distinguish `candidateCategoryId` (also kept as
`spendingCategoryId`) from `categoryOverride`, the category input persisted on a
newly created Expense, and `effectiveCategory`, the canonical resolution of the
prospective Expense and Purchase. Preserve these fields in the commit request.
A null override stores no Expense category override; bare Purchase creation
also leaves its category null. The Expense's effective category may inherit from
its context or remain Uncategorized, so the preview's candidate label does not
prove the resulting classification. The effective resolution includes its
provenance and a null value means Uncategorized. `existingCategories` shows the
canonical resolutions of the selected Purchase's lines; `link_existing`
preserves them. Commit rechecks the live classification policy and projected
result.

Optional reviewed `beneficiaries` in direct booking and statement `booking` use
the attribution role format. Omission and an empty reset keep the normal
beneficiary defaults; a null-party share explicitly records unknown
beneficiaries, distinct from Household or a named member. Nonempty shares keep
their exact parties and weights in the review fingerprint and are written by the
Expense attribution owner in the same transaction as booking. A stale or
deleted party refuses the booking. Linking or settling existing spending refuses
creation-only beneficiary choices and preserves every recorded attribution.

Source aggregate creation defaults ordinary purchases to `materials` and fees
to `services`. Optional `booking.costType` in statement review chooses
`materials`, `tools` or `services` for a new aggregate Expense; its draft
control and preview show the choice before application. An absent choice keeps
the defaults and retained request fingerprints. An explicit cost type is
refused when linking or settling existing spending; those actions preserve the
Expenses. Direct `finance.book_transaction` also accepts `costType`. Choose it
in the original booking rather than editing the resulting Expense.

For an authorized explicit booking, check existing Purchases, Expenses and
settlement allocations before creating aggregate spending. Refresh that check
when resuming a retained proposal; a fresh booking preview checks the selected
transaction's state, not the completeness of a prior duplicate search.

Choose cost type from what was purchased: a membership service uses `services`,
even when the Vendor usually sells goods. Vendor-default spending categories
are suggestions, not evidence of the purchase's purpose. Resolve category IDs
against live records before previewing; a merged category's successor need not
fit the purchase. When category is uncertain, preserve supported booking under
the member's uncategorized-booking policy rather than inventing a category.

Keep issuer benefit credits separate from purchase charges. Equal amounts,
nearby dates and a membership benefit do not alone prove a credit allocation or
net household cost. Review their meaning and settlement independently. After
commit, read back the Purchase, Expense, allocation and attribution graph; check
effective category and beneficiary defaults rather than assuming empty
overrides mean uncategorized or Household. Preserve explicit member decisions
about who benefits independently of who funded the payment. Report booked gross
spending separately from unresolved credits.

Historical classification edits remain member decisions. The retained booking
fingerprint hashes full Expense lineage, including names, notes, URLs and
joined attribution/source-claim rows, so even a descriptive edit can require
review during fresh convergence. The stored digest keeps no projected monetary
proof against which a narrower comparison could safely run; a projected current
hash cannot be compared to the stored full-row hash. This guard also protects
automatic financial evidence corrections. Exact statement command replay still
returns its committed receipt. Never reset fingerprints or undo member edits to
force convergence.

### Source identity review

Charges with no current observation in a ready occurrence publish no
Transaction suggestion (a
withdrawn or superseded head of a ready occurrence keeps its booking review): Source identity review is their one surface, and
generation supersedes pending advice already published for them (rows, paid
labels and member decisions remain; a later proven occurrence publishes again).
Applying held advice not yet superseded returns the held reason. Exact
identity converges during intake
([holds and identity resolution](#holds-and-identity-resolution)). Reviewed identity decisions can
use `entity.commands` batches of up to 50 independent SourceRecord updates, each
with its own `expectedDisposition`, fingerprint/version/accepted-owner/history
checks and explicit judgment. `assign` refuses a conflicting original account or
disposition. Historical reconciliation uses this audited batch path; it does
not guess identity or require a web action. Publishing a current occurrence
review supersedes pending advice for its observations under older keys without
deleting paid labels or member decisions; dismissing held advice does not
suppress a later proven occurrence.

Verify with `entity_read.list` using `entity: sourceOccurrence`, `filters.ids`
and `fields: ["closure"]` in groups of at most 10 owners. Ordinary get/list
reads omit the snapshot, and get does not publish this explicit list
projection. One snapshot loads the shared observation, proof, judgment,
membership, alias and accepted/historical money graphs once per page, including
retained sibling-alias history. Alias context can name observations outside the
selected owners; it never expands accepted ownership or authorizes a write.
Named sets keep stable storage handles, original relationships and tombstones.
Canonical live Expense reads supply effective beneficiaries/funders and category
provenance beside recorded weights and overrides. Each named set refuses
overflow above 1,000 rows rather than returning partial coverage. `scope` names
the complete requested owner cohort; the first result alone carries the bounded
cohort bundle, whose scope covers every requested owner, and remaining results
omit closure. TransactionImport notes are omitted. Raw and enriched bundles
refuse above one MiB before returning, which bounds serialization as well as row
count. Use versions inside the bundle for later review fences. Historical links
and receipt references remain read-only evidence. The projection is hidden from
ordinary list/detail display and creates no money or work. Identity-only
collection references and retained retries read physical observations with
explicit owner keys, and automatic eligibility hashes the complete
unresolved-owner fence once rather than per suggestion.
