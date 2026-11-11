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

## Statement booking

Bank transactions are evidence; Expenses are the spending ledger. Statement
imports and re-imports discover booking work for every observed charge,
including unchanged observations already matched to an unbooked transaction.
Clean purchases and fees book spending automatically; uncertain work remains in
the shared Suggestions queue. Transfers, card payments and ordinary income
remain settlement-only: clean ones are created automatically without Expenses,
and a money move is clean only with its clean opposite leg, created as a pair.
All money continues to be `SUM(Expense.cost)`.

Pending or unknown provider status does not prevent an otherwise supported
booking, and spending advice is generated for pending and observed spending
under the same eligibility as posted spending. Unknown status is kept as null
on evidence and observed on the FinancialTransaction, never fabricated as
posted. Label-policy revisions invalidate checkpoints when advice eligibility
changes. Transaction booking and evidence coverage use those same observed,
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
live, household-owned credit card books with an unknown individual purchaser,
including shared access or missing primary-cardholder evidence. A household is
never stored as a member purchaser override. Missing/deleted owners, guest
owners, deleted accounts and household bank accounts remain guarded. Explicit
member choices and an existing Purchase's overrides and inherited
receipt/order/member evidence remain authoritative. Funding attribution remains
its own dated contract.

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

The financial spending planner and booking writer are shared by direct finance
commands, statement create/attach/supersede, matched-transaction `book`, and
import convergence. Current evidence and the complete allocation graph are
revalidated in the outer serializable write with its application receipt. The
review family declares this snapshot requirement; unrelated review families
keep their transaction boundaries. Attach plans use the target transaction's
current facts, since attaching evidence alone changes no kind, amount or
posting state. Already-booked spending is a no-op, and another possible
Purchase prevents a new clean booking.

Discovery selects candidates from names, dates, amounts and retained payment
evidence before reading their receipt graphs. The payment matcher rejects
prospective charges that cannot match any retained payment line before loading
stored charge competitors; plausible payments keep the complete planner. A
review-only positive-charge plan with an unresolved booking prerequisite does
not hydrate candidate Expenses, attributions, allocations or vendor category
history; refund category inheritance and already-booked checks still read their
graphs. Page preparation batches read-only candidate facts and coalesces
in-flight receipt-graph reads for concurrent previews; eligible candidates'
payment-evidence rows load together in per-Purchase order, and review-only
candidates load none. Cached page evidence never reaches a booking commit. The
graph reader keeps compact decision fields and canonical JSON of the complete
graph, and snapshot hashing reproduces identical fingerprint bytes;
attributions, notes and payment-account facts remain evidence dependencies.
Ready plans and commit-time validation recheck those dependencies and current
ownership. Persisted booking-lineage fingerprints are unchanged by any of this.

Matched transactions with live allocations create no new statement booking
work; an existing pending booking is revisited so completion can retire it.
Expense edits use generic field Suggestions, and allocation reconciliation uses
explicit finance commands. Transactions without statement observations can
invoke the shared commands directly; statement discovery uses retained rows.

### Categories and Vendors

Clean new spending keeps the transaction-kind agreement, identity, ownership and
money checks. Missing, uncertain or conflicting category advice does not block
otherwise-supported booking: the aggregate Expense stays Uncategorized and its
missing effective category enters the shared Work queue. Apply a proposed
category only when it is live, high confidence and consistent with merchant
history, or the member reviewed that history. Explicit reviewed category
choices still refuse deleted categories or unacknowledged conflicts. Category
history is optional and there is no amount cap.

The provider category stays verbatim evidence. Vendor name/alias resolution
runs first; an unresolved merchant may propose a supported cleaned business
name and keep the literal merchant alias. Person, processor-only, unsupported
and competing identities need review. Both names resolve again before a Vendor
and its booking are created atomically; one charge never establishes a
Vendor-wide spending default. A member may explicitly choose an existing Vendor
and acknowledge conflicting category history while correcting a held booking.
Reviewed category and new business-name choices are kept separately from model
advice. Booking corrections use the server's retained advice and explicit
reviewed fields; clients cannot submit replacement model evidence.

### Settling existing Purchases and refunds

Existing Purchase settlement reuses the retained-payment matcher: exact cents,
card/tender and owner evidence, the posting window, and a complete unique
conserved set. The same evidence checks apply to pending and observed charges;
status alone neither proves identity nor prevents settlement. Weaker
same-Vendor candidates within fourteen days, including tips, partial payments,
splits and combined charges, need review; amount/date coincidence alone does not
prove identity. One exception settles automatically: a positive purchase charge
whose only exact match is one unpaid same-Vendor receipt within three days, with
no retained payment evidence, open capacity equal to the charge, no older blocking spending, and no other
unbooked charge or Transaction for that amount within three days of the
receipt. That link is the same capacity-checked link a member would choose.

Nearby candidates without explicit payment or member evidence require review
only when known remaining Purchase capacity can cover the charge, or capacity
is unknown. Settled Purchases and those with insufficient remaining capacity
remain visible as context and do not prevent automatic new spending.

For positive charges, actual nonfuture vendor Expenses on partly paid
same-Vendor Purchases outside that window or without dates also prevent
automatic new spending while their complete graphs have open, unknown or
overcovered settlement capacity. Partly paid means at least one positive
payment is allocated and the charge-side vendor lines differ from the positive
allocations, a line is unknown or unclassified, or an allocated payment is not
plain posted settlement or is booked by a reimbursement line, as with
installment plans and payment schedules. Undated retained payment evidence for
the exact charge amount also keeps an older Purchase as a blocker. Otherwise an
older Purchase with no allocated payment does not block a later charge.
These additional candidates are review-only: even a complete retained payment
set cannot make them automatic settlement targets. Only confidently zero
remaining capacity excludes an additional candidate. A nearby candidate is
excluded only when its capacity is confidently zero and every settling
Transaction was accepted from a provably different bank event of the charge's
source: another provider ID in the same provider scope, or another position in
the same collection, as an earlier booking from the same feed creates. A
manual, legacy, reviewed or cross-kind settlement may be this same charge and
keeps blocking. Complete settlement targets, the
explicitly chosen Purchase, refund originals and Purchases whose retained
payment evidence names the charge's amount stay intact. Explicit member
selection or rejection keeps its authority. A header total without actual vendor lines is outside this
check, and exhausted capacity does not prove source-event identity.

Refunds require supported original-Purchase evidence independently of that
weak-candidate window. Reuse recorded negative Expenses before creating a
negative lump line. An identified original's single live effective category on
vendor spending, excluding future and reimbursement lines, supplies the refund
category unless a member explicitly chooses another. An unmatched refund needs
explicit review before a standalone refund Purchase is booked.

### Automatic booking rule

The clean import booking rule (clean spending creates, books and supersedes,
clean income, transfer and card-payment creates, and paired copy attaches) is fixed code and always on; there is no member
switch or audit sample. Each application still uses `suggestions.review` and records automatic authority and its policy
revision in Changes by Cubby. Booking writes are import evidence: they are not
Cubby-set field values, and field automation never revises them. Changing a booking policy never turns an old
transaction-only receipt into proof of spending; regenerate and revalidate the
unbooked work.

Wrong feedback preserves the original Suggestion, its automatic application
receipt and booked records. It records a review, not an undo or a repair
request for already-booked Purchases, Expenses or allocations. The next
suggestion run uses the current-evidence rules: eligible field questions can be
reassessed, while an unchanged rejected answer is withheld from automatic
application. An unchanged rejected statement suggestion remains rejected.
Changed evidence may produce a new suggestion; there is no historical
correction pass. Shared correction coordination explicitly holds semantic
repair for `statement_transaction` and `transfer_pair`; these families have no
supported ready plan. Source amount/withdrawal correction requires its own
current source proof and never grants authority for kind/category changes or
transfer re-pairing.

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
occurrence for every observation, including legacy records. Observation notes
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

Evidence, memberships, revisions and the statement Sweep's Job intent commit in
one transaction; waking happens after commit. Corrections recheck the automatic
spending switch under its transaction lock; pausing it blocks money changes and
retirement as well as new booking. Scheduling failure rolls admission back. The
outer DB-only snapshot write uses bounded retries for serialization conflicts,
including late derived-refresh Job contention, rebuilding evidence and Sweep
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

### Statement Sweeps

Recording rows starts a routine statement Sweep; `run.sweep` reruns it. Default
background labeling is unscoped.

**Label reuse.** A repeated Sweep keeps labels for the same source and charge
key when the statement model inputs and the candidate identities/model inputs
match, and the recorded label prompt revision is current. Bump
`STATEMENT_LABEL_REVISION` with any statement label prompt or model-policy
change; it keeps the deployed revision so compatible labels survive.
Observation occurrences, memos, rule/history votes and clean-policy changes can
move the broader evidence fingerprint without requiring fresh model decisions.
Replacement suggestions keep the original model provenance, copy only the model
votes and candidate labels, and recompute kind and clean status from current
rules, history and transfer evidence. Changed model inputs or candidates retire
the old labels atomically with the replacement; suppressed or settled charges
remain excluded. Paid labels may be reused across aliases only when their exact
model inputs and policy still agree. Acceptance always validates the current
broader evidence fingerprint.

**Pages.** Generation commits bounded batches of independent charges: import-
scoped generation, labeling and retained generation retries admit at most 16
charges per page, because they regenerate and apply money sequentially;
unscoped generation selects at most 32; holds and explicit callers keep the
512-suggestion ceiling ([statement pages](jobs.md#statement-pages)). Label pages
default to 32 suggestions. Identity questions stay batched; merchant/spending
preparation runs in waves of at most 32, with field questions batched within
each wave, and a single page allowance admits fresh context-fitting questions
in identity/kind/counterparty/spending order, reserving spending before the
next charge. Compatible checkpoint answers stay eligible after the allowance is
exhausted. Untouched charges keep their complete candidate population and
inclusive cursor; they receive no empty checkpoint, skipped outcome or
completion. Cooperative pages stop admitting new spending work after 20
seconds, settle started work and save partial answers before yielding; the
deadline does not interrupt an in-flight provider request. Cache contention and
lookup deferrals remain typed waits, neither retained item failures nor
triggers for uncached model calls. Failed items remain unresolved even after
scanning ends: a completed scan with retained failures is not completed
reconciliation. Page caches are discarded after their page: label work,
publication and financial application rebuild current facts, and a commit
never uses a page cache as validation. These bounds limit repeated work after
interruption; they are no wall-time guarantee.

**Publication and application.** Complete labels publish in batches of at most
32 charges with at most four publication transactions in flight; partial
checkpoints remain per charge. Each completed label keeps its own producer,
checkpoint, Suggestion receipt and original application order. A failed batch
reconciles each charge through the same locked admission path: committed
publications recover their pending application receipts before testing the
obsolete input fence, and finish retirement before acknowledgement; recovery
does not recreate or restamp labels. Resumed application receipts repeat that
exact retirement check before application, including recovery from a crash
before the after-commit callback started. Automatic financial application
admits only the original ready prefix, sequentially. Charges already skipped by
the current label page do not split that prefix; failed, unfinished and
applicable-rule charges stop it. Unscoped passes may complete consecutive
no-action receipts in bounded transactions: lock the exact receipts, verify
their charge/evidence, active pending state and absent rule descriptors, then
clear only the proven prefix through the projection writer. A missing, replaced
or rule-bearing receipt stops the batch (current
import-only rules cannot execute outside import admission, so their stamps do
not). Import-scoped passes regenerate before each admission that follows an
applied rule on the same page, since regeneration can introduce actionable
rules. Statement application and booking request only
identity output from their mutation writers when they consume only IDs; the
writers keep validation, locks, audits, allocations and receipts.

**Retries.** Retrying failed statement labels consumes only the retained charge
references, one charge at a time, without moving the original population
cursor. Each charge is regenerated under the Run's retained account/date/import
scope before its current label work is selected. Model waits and funding pauses
keep that charge; disabled automatic AI work pauses the retry rather than
discarding it. Healthy charges and later arrivals are not added to the retry
population. An obsolete Job generation or lease interrupts the invocation;
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
and scoped checkpoints, label publications and receipt completions recheck the
live resolver inside their write transactions, so valid fresh evidence for
another account cannot authorize an effect. An out-of-scope result keeps
evidence and paid checkpoints without publishing or acknowledging that target;
excluded receipts keep `applicationPending` and their original
`applicationOrder`, and completion counts include only IDs the writer admitted.

`run.sweep` and its estimate accept a statement family's optional `importId` as
a TransactionImport shortcode (`TIM-…`). Both resolve the live retained
collection before estimation or Run/Job creation; invalid, missing and deleted
references refuse. Account and date filters intersect its retained charge
membership. Selected charges still use current observations from other
collections sharing their identity; unrelated charge identities stay excluded.
This reprocesses retained evidence under the automatic policies, including
clean spending booking. Account/date scope alone does not grant import-clean
authority, and attachments wait for review. Incomplete collections allow supported positive
processing but prove no absence, withdrawal, reconciliation or completion. A
Sweep changes neither collection coverage nor `completedAt` and records no
withdrawals.

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
amounts never enter `Expense.cost`, USD payment evidence or USD sums. Exact
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
amounts and Purchase `statedTotalMinor` (nullable). Sums, keys, conservation,
merging and direct comparisons use minor units. Native, MCP, entity and audit
wires, purchase-import and spending boundaries, and retained fingerprints keep
dollar numbers (`amount`, `statedTotal`), including the frozen reconciliation
fingerprint shape. Source extracts and successful receipts are never rewritten.
`Expense.cost` stays a dollar value until its noisy originals have exact
decimal evidence or a member judgment; a diagnostic tolerance classifies
floating noise but never authorizes rounding stored money.

SQL money projections share `server/db/computed/money.ts`, with explicit numeric
or float8 result types. Raw SQL dollar fields entering retained JavaScript
fingerprints, including embedded transaction JSON, must use the PostgreSQL
float8 driver boundary or an explicit decoder; an `execute<T>` annotation does
not decode numeric strings. Retained float-sum fingerprints keep their per-row
float8 accumulation, and SQL-hashed JSON/text boundaries keep the float8
representation rather than numeric scale; authoritative conservation and writes
use minor units.

## Validation boundaries

`import-order-convergence.integration.test.ts` exercises a Latin square plus two
seeded arrival orders of Gmail, retailer, photo and normalized financial
evidence against PostgreSQL through the same writers the routes dispatch: real
normalization, persistence, retailer preparation/commit, photo
staging/finalization/review, normalized intake, booking, finding resolution and
order-mail linking. It owns the sampled source orders and exact final Product,
inventory ownership, Expense, Purchase allocation and original source edges.
External classifier/image-description output is deterministic. No browser
journey covers the combined four-source sequence.
`gmail.input-first-import.spec.ts` covers input acquisition, reviewed statement
booking and receipt reconciliation, Product conflict review, and
Vendor-to-Purchase and original Email navigation, including applying a reviewed
fix from the Run page. Photo review and photo-first journeys cover signed
upload, review approval and persisted image roles.

The normalized evidence PostgreSQL contracts cover replay, complete-window
admission, distinct occurrences, immutable revisions and monotonic withdrawal.
The MCP catalog regression verifies that dry runs and unchanged replays create
no Runs, Jobs, Suggestions or money. Financial correction contracts verify
atomic amounts, allocations, attribution preservation and guarded retirement.
`finance-evidence-journey.spec.ts` covers reviewed spending, reimbursements,
corrections, transfer conversion and refusal after edits. SQL boundary
regressions cover settlement identity, receipt-policy precedence, quality
exceptions, cent-preserving replacement and refund capacity.

The Mac runner is documented in
[mac-import-e2e.md](../apps/web/tooling/mac-import-e2e.md). It builds and signs a
separate app identity, uses fixture account/browser state, and records each
exercised boundary independently. A successful build does not establish native
capture, photo approval or product import. Locked-host or authentication
failures must remain failed milestones. Live Gmail authorization, live retailer
changes and physical iPhone photo quality remain distinct from deterministic
import convergence.

## Reviewing statement outcomes

Public `run.sweep` family entries take `importId`, `accountIds` and `since`
directly, for example `{ family: "statement_transaction", importId: "TIM-4K7MN" }`.
Unknown fields, including a nested `scope`, are rejected before any Run starts;
an invalid scope must never silently broaden a financial pass.

Matched booking discovery can use the accepted transaction's live account when
retained source bindings, provider scope, aliases and card evidence resolve no
account. This server-owned fallback neither writes an alias nor changes source
facts. Ambiguous or conflicting provider scope cannot use it. A resolved source
account that differs from the accepted transaction remains an explicit review
conflict and cannot qualify as clean advice. Generation and fresh application
rebuild use the same account resolution.

The shared Suggestions list and counts accept retained source observations and
TransactionImports in `recordIds`. Source scope follows the charge identity
across revisions, and collection scope uses retained membership rather than
first ownership. Multiple observations of one charge return one proposal. These
reads expose served proposals only: an empty result does not establish complete
source coverage or reconciliation, and listing does not refresh or validate an
application. Preview and acceptance keep their current-evidence guards. Source
scoping changes no overlap or financial identity decisions.

Suggestions is the reconciliation workspace: pending proposals and the Changes
by Cubby audit. Source transaction records is
the generic imported-evidence browser; Transaction imports shows the retained
collections. Each import's reconciliation report separates retained-observation
match states from booking coverage for its distinct matched Financial
Transactions. Charge matching includes retained revisions outside the selected
collection; repeated observations do not multiply its transaction counts.
Collections can overlap, so their figures are not additive. Unmatched evidence
is outside the booking denominator, and recorded booking proves neither
balanced settlement, source completeness nor itemization. Filter the declared
evidence projection by account, amount, date and match state as needed. Several
observations can describe the same charge.

Statement review shows Source, Proposed result and Evidence. The read-only
`sourceTransactionRecord.previewSuggestion` (MCP
`finance_read.preview_suggestion`) revalidates the Suggestion fingerprint and
live charge before projecting a draft through the same action gates and
spending planner as acceptance. Published review holds, including source
lifecycle conflicts, refuse both preview and acceptance before projecting
financial effects. It writes no aliases or records. The preview identifies
transaction changes, vendor reuse/creation and alias effects, Purchase/Expense
and settlement effects, purchaser basis and the explicit vendor-account state.
Changing a web draft refreshes the reviewed result; acceptance still replans
inside its write boundary. Agents may call the preview to inspect uncertain
effects; it is optional, never acceptance authority or a prerequisite to a
supported `suggestions.review`. The write always validates the current
Suggestion, application and spending. Preview and acceptance rebuild the charge
from retained evidence, carry the reviewed model labels onto it, and refuse,
naming each part, only when what the chosen action writes changed: the
account, statement date and provider status, plus a create's transaction fields,
paired transaction and transfer, an attach's target (its amount, differing
fields and eligibility), or the superseded, voided or matched transaction.
Accepting the recommendation as reviewed also refuses when a ready booking's
effect, purchaser, Vendor, category or Purchase moved (`spending.<field>`).
Other candidates, merchant history, sibling and snapshot drift do not refuse; a
correction's own action, kind or booking is replanned at acceptance.

Candidates share the generic eligible-target predicate. A transaction another
charge already settles or claims, or one of the wrong sign, amount or kind,
stays listed as `eligibility: "context"` with its `contextReason`; it never
blocks a create, never earns an attach recommendation, and attaching to it
refuses with the next step. Evidence that names a transaction (a provider match,
an identity hold, or the booked copy of the same bank event) marks it
`explicit`.

Explicit MCP review supplying `booking` or `kindOverride`, or choosing a
nonrecommended action, uses `verdict: "wrong"` with
`correction: { present: true, value: application }` and the same `application`.
This includes a Create draft that keeps the recommended action but supplies
booking choices. Preview checks financial effects; application also enforces
the verdict and correction-presence contract. Kind controls apply only to a
Create draft; an attachment first uses Preview new transaction to review that
alternative. Provider category is evidence, not a Cubby spending-category
assignment: keep each provider/category observation, joining other provider
charges only through authoritative settlement references to the same
transaction.

Statement attachment also converges spending. A spending result requiring
review blocks attachment even when no transaction fields are selected. For an
already accepted transaction with a separately authorized explicit booking,
inspect existing spending, book through the supported command, then refresh the
proposal against that booking. Preserve the accepted transaction, source
references and allocations. A lineage refusal remains unresolved; never restore
Expense values or member attribution to force attachment. An authorized
identity-only repair must merge the current reference set atomically through
the writer; replacing a client-side snapshot can remove concurrent attachments.

### Working the statement backlog

Recording rows starts a routine Sweep that turns each unmatched charge into one
Transaction suggestion (`suggestions_read.list` with `family:
"statement_transaction"`; `groups: "account_month"` adds per account × month
sections with clean counts); `run.sweep {families: [{family:
"statement_transaction"}]}` reruns it after hand edits to transactions or
accounts, and `run_read.work_snapshot` follows its Steps. Burn the backlog
group by group, filtering a group with
`where {account: {in: [FAC-…]}, month: {in: [YYYY-MM]}}`:

1. Accept `clean: true` suggestions in batches of up to 100 with
   `suggestions.review`: verdict `correct`, intent `apply`,
   `expectedFingerprint` (the row's `fingerprint`), and `application {kind:
   "statement_transaction", action: <recommended>}`; an attach also names
   `transactionId`, the first candidate. For transfer/card-payment creates use
   the opposite-leg rule in step 5. Other creates are clean only when at least
   two of `create.votes` (category `rule`, model `label`, merchant `history`)
   name its kind and none disagrees, and `create.counterparty` is a business
   (on a stored-value account such as a payment app, history must say so). A
   card benefit, statement credit or issuer promotion is an `adjustment`, not a
   `refund` (a merchant giving money back for returned goods), even when it
   names the merchant of the purchase it offsets; merchant history is kept per
   direction, so a couple of corrected credits teach it.
2. Read every other suggestion before choosing. An attach candidate's model
   `label` is advisory — confirm the descriptors yourself, and below about $20
   read both. When every candidate is a different amount and labelled
   `different` with high confidence, the recommendation is `create`; the
   candidates stay listed, and accepting as is rejects them. Attach to a different candidate, tick `fields`, override the
   kind, or create anyway (`rejectedCandidateIds` listing every candidate) as
   verdict `wrong` with `correction {present: true, value: <the same
   application>}`. Applying a suggestion republishes the pending suggestions
   near it on the same account. A create still applies when a candidate
   appeared since review: the refusal names it, and listing it in
   `rejectedCandidateIds` retries the same review.
3. A charge with `siblings` has a same-amount charge from another export: the
   pair may be one charge whose descriptor firmed up. Within one source,
   supersede the thinner row (generic `entity.update` on
   `sourceTransactionRecord`, setting `supersededByRowId` to the reviewed
   successor record ID) before creating either. Siblings from other sources
   mean their counts disagree (see [Matching](#matching)): book each real
   charge once and attach the other sources' copies to it. A `context`
   candidate with `contextReason: "claimed"` already settles another charge,
   so the recommendation is `create`; two visits for the same amount are two
   creates.
4. A person counterparty is never clean. An outgoing payment to a person is
   your share of a shared cost: create it as `purchase` and set the merchant.
   An incoming one is a repayment: create it, then book it with
   `finance.book_transaction` as `economicRole: "reimbursement"`.
5. A `transfer` names the member's own balance account a cash-out or funding
   descriptor points at (Venmo-style and payout balances are `stored_value`;
   PayPal is read like a card). `transfer_pair` Suggestions stay reviewable on
   the global Suggestions page or through `suggestions_read.list`; Sweeps do
   not generate new ones. Accept using verdict `correct`, intent `apply`,
   `expectedFingerprint` and `application {kind: "transfer_pair"}`. It creates
   missing statement-backed legs and accepts the pair atomically. The family
   and statement creates share the
   [opposite-leg clean policy](household-contribution-ledger.md#opposite-leg-clean-policy).
   Cross-owner pairs always need review and record a LedgerTransfer.
   An ATM withdrawal moves money into the `cash` account of the bank account's
   owner (a household checking's cash is the household's), so it is an
   internal move. Cash has no statement: review the proposal to create its
   full-amount leg on the owner's unique cash account, or enter the leg by
   hand. A proposed cash leg is never clean. Record the known ATM fee
   separately as a `fee` on cash; never infer a fee amount. Settle cash
   spending from that account against its Purchase. A cash account never
   reconciles: cash spent and not remembered stays as an unexplained balance on
   purpose. Never invent spending to close it, and never settle a Purchase from
   cash without evidence that the cash paid it. Review unresolved overlapping
   exports before creating a leg; confirmed observations must share one
   FinancialTransaction. Amount and nearby dates alone cannot establish charge
   identity.
6. Dismiss charges that should never become transactions with verdict
   `dismissed` and suppression `{scope: "statement_transaction", candidateKey:
   "<source>:<chargeKey>", fingerprint}`; prefer `disposition: "ignored"` with a
   reason when the whole row must never become a transaction, because that also
   settles every observation. Every real charge is in scope, consumer spend
   included: ignore only duplicates of another export's row, pre-Cubby rows and
   mis-parsed lines, never `not_modeled`.

A refusal (reviewed fields changed, a live candidate, a stale hold, an attach with
several candidates and no named `transactionId`) writes nothing. Labelling
republishes a suggestion as a new Suggestion, so a stale-Suggestion error means
re-list the group and review the replacement. Explicit pending-to-posted
evidence can support a reviewed supersession. Disappearance requires the
complete scope and explicit source confirmation in
[financial-evidence-import](../.agents/skills/financial-evidence-import/SKILL.md#withdrawals).
Age or absence from a later export alone does not authorize voiding a hold.

### Retained review holds and preservation

For temporary review holds, keep prior judgments and a unique marker, keep the
cases visible in the member review, and count them as unresolved. If holding
depends on current booking eligibility, check that eligibility and apply the
hold atomically with the relevant source and transaction locks. Intake copies
judgments into later revisions: reopening must discover original rows and
marked descendants within the proven source identity. Restore only exact
temporary-hold matches and preserve every newer member decision; restoring a
fixed list of old row IDs can leave newer observations held.

Before resuming a retained booking case, read the member review and saved case
plans for the exact source, transaction and Purchase identities. Carry
unresolved objections and explicit decisions into the next review brief. A new
preview, approval or successful replay does not itself supersede a prior hold.
Resolve the objection against current evidence and the owning policy before
writing; keep the earlier finding and record why the case can proceed.
Distinguish a reviewer's recommendation from a member's decision. A later
review cannot override an explicit member decision.

Identify intended targets inside protected cohort snapshots before writing.
Preserve every unrelated row and allow only the exact reviewed target effects,
including their specific booking timestamps and allocations. Do not exclude an
entire set or broadly ignore timestamp changes because a target appears there.
Receipt replay and independent preservation read-back establish separate facts.

### Statement review receipts and classification

Statement `suggestions.review` application records a command receipt with
operation ID `command-application:<operationId>` in the `decisions` of the
Suggestion identified by the review handle. Read that Suggestion by the handle,
not by `evaluationId`. This family does not require `acceptanceReceipt` to
establish successful application.

Replay the exact committed review request under the same actor and operation
ID. The generic command returns its original applied outcome from the receipt
before reapplying the family or checking current spending fingerprints. Compare
the original Suggestion, its decision entry, status and applied result, then
independently verify unchanged source, ledger and attribution graphs. This API
does not return the `replayed: true` flag used by direct
`finance.commit_booking`; that writer has its own replay and current-lineage
checks.

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
