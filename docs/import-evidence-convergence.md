# Purchase, photo, and statement evidence

Source-reference invalidation checks include removed observations: a retained
reference to a deleted, ignored or superseded observation invalidates current
advice. The source/external-ID lookup index therefore includes tombstones; the
separate live-only unique index still enforces active observation identity.

Bank transactions are evidence; Expenses are the spending ledger. Statement
imports and re-imports discover booking work for every observed charge,
including unchanged observations already matched to an unbooked transaction.
Clean purchases and fees book spending automatically; uncertain work
remains in the shared Suggestions queue. Pending or unknown provider status
does not prevent an otherwise supported booking. Spending advice is generated
for pending and observed spending under the same eligibility as posted spending.
Label-policy revisions invalidate checkpoints when advice eligibility changes.
Unknown status is retained
as null on evidence and observed on the FinancialTransaction, never fabricated
as posted. Transfers, card payments and ordinary income remain settlement-only.
Booking links recorded Expenses or creates one bare Purchase and one lump
Expense. Purchases created from bank evidence have no invented itemization,
order identifier or printed total. New bare Purchases preserve a live member
account owner as purchaser, otherwise use the live primary member of a
household credit card only when no authorized-user period includes the spending
date (transaction date, then posted date). Otherwise-supported spending on a live,
household-owned credit card books with an unknown individual
purchaser, including shared access or missing primary-cardholder evidence. A
household is never stored as a member purchaser override. Missing/deleted owners,
guest owners, deleted accounts and household bank accounts remain
guarded. Explicit member choices and an existing Purchase's overrides and
inherited receipt/order/member evidence remain authoritative. Funding attribution
remains its own dated contract.

Spending policy `2026-10-24.2` makes ready-plan `purchaserId` nullable in place;
statement label policy `2026-10-24.1` invalidates prior eligibility checkpoints.
regenerate native schemas and reconnect cached MCP clients for this wire change.
Apple compatibility version `2.68.0` rejects older writes that cannot return the
required purchaser proof with an approval.
Approval snapshots include account authority, dated access and holder evidence.
Ready plans and direct booking previews retain a separate `purchaserSnapshot`
for replay validation of that evidence even when both old and new
individual purchaser values are null; changed or absent proof requires fresh
review. Retained older proposals remain readable without that proof, but cannot
commit or replay as accepted ready plans.

Purchase inheritance and booking share the sole-access predicate; page previews
batch holder proof and commits recheck current holder and access evidence.
When settlement links an existing receipt, sole-card inheritance requires sole
access on both the receipt/order date and charge date (posted date fallback).
A shared charge therefore preserves known receipt-member evidence across
different dates; settlement never freezes that derived value into an override.

Transaction booking and evidence coverage use those same observed, pending and
posted states. Supported unbooked spending remains a booking gap before posting;
expected or void transactions, transfers and ordinary income remain outside that
requirement. Stored quality flags adopt policy changes through the existing
quality refresh owner; a coverage-policy change starts no financial Sweep or
booking work.

The financial spending planner and booking writer are shared by direct finance
commands, statement create/attach/supersede, matched-transaction `book`, and
import convergence. Current evidence and the complete allocation graph are
revalidated in the outer serializable write with its application receipt.
The review family declares this snapshot requirement; unrelated review families
retain their existing transaction boundaries. Attach plans use the target
transaction's current facts, since attaching evidence alone changes no kind,
amount or posting state.
Already-booked spending is a no-op, and another possible Purchase prevents a
new clean booking. All money continues to be `SUM(Expense.cost)`.
Discovery selects candidates from names, dates, amounts and retained payment
evidence before reading their receipt graphs. The existing payment matcher
rejects prospective charges that cannot match any retained payment line before loading
stored charge competitors; plausible payments retain the complete planner. A review-only positive-charge
plan with an unresolved booking prerequisite does not hydrate candidate
Expenses, attributions, allocations or vendor category history. Refund category inheritance and
already-booked checks still read their necessary graphs. Page preparation
batches read-only candidate facts and coalesces in-flight receipt-graph reads
for concurrent previews. Cached page evidence never reaches a booking commit.
Eligible candidates' complete payment-evidence rows are fetched together with
their existing per-Purchase ordering; review-only candidates remain excluded.
The graph reader retains compact decision fields and canonical JSON of the
complete graph after each bounded hydration batch. Snapshot hashing streams
that JSON back into its original positions with identical fingerprint bytes;
attributions, notes and payment-account facts remain evidence dependencies.
Ready plans and commit-time validation recheck those complete dependencies
and current ownership. Persisted booking-lineage fingerprints are unchanged.
Matched transactions with live allocations create no new statement booking
work; an existing pending booking is revisited so completion can retire it.
Expense edits use generic field Suggestions, and allocation reconciliation uses
explicit finance commands. Transactions without statement observations can
invoke the shared commands directly; statement discovery uses retained rows.

Clean new spending retains the existing transaction-kind agreement, identity,
ownership and money checks. Missing, uncertain or conflicting category advice
does not block otherwise-supported booking: the aggregate Expense stays
Uncategorized and its missing effective category enters the shared Work queue.
Apply a proposed category only when it is live, high confidence and consistent
with merchant history, or the member reviewed that history. Explicit reviewed
category choices still refuse deleted categories or unacknowledged conflicts.
Category history is optional and there is no amount cap.
The provider category stays verbatim evidence. Vendor name/alias resolution
runs first; an unresolved merchant may propose a supported cleaned business
name and retain the literal merchant alias. Person, processor-only, unsupported
and competing identities need review. Both names resolve again before a Vendor
and its booking are created atomically; one charge never establishes a
Vendor-wide spending default. A member may explicitly choose an existing Vendor
and acknowledge conflicting category history while correcting a held booking.
Reviewed category and new business-name choices are retained separately from
model advice. Booking corrections use the server's retained advice and explicit
reviewed fields; clients cannot submit replacement model evidence.

Existing Purchase settlement reuses the retained-payment matcher: exact cents,
card/tender and owner evidence, the existing posting window, and a complete
unique conserved set. The same evidence checks apply to pending and
observed charges; status alone neither proves identity nor prevents settlement. Weaker same-Vendor candidates within fourteen days,
including tips, partial payments, splits and combined charges, need review;
amount/date coincidence never proves identity. For positive charges, actual
nonfuture vendor Expenses on same-Vendor Purchases outside that window or without dates also prevent
automatic new spending while their complete graphs have open, unknown or
overcovered settlement capacity. These additional candidates are review-only:
even a complete retained payment set cannot make them automatic settlement
targets. Only confidently zero remaining capacity excludes an additional
candidate; existing nearby/payment/explicit selectors remain intact. Explicit
member selection or rejection retains its existing authority. A header total
without actual vendor lines is outside this check, and exhausted capacity does
not prove source-event identity. Refunds require supported
original-Purchase evidence independently of that weak-candidate window. Reuse
recorded negative Expenses before creating a negative lump line. An identified
original's single live effective category on vendor spending, excluding future
and reimbursement lines, supplies the refund category unless
a member explicitly chooses another. An unmatched
refund needs explicit review before a standalone refund Purchase is booked.

The clean import booking rule is enabled by default and appears in Automatic
rules. A member can pause it or resume it without a measured-precision threshold.
Pausing leaves future clean spending suggestions Pending, including clean
attachments that would book spending through the measured attach rule. The pause
survives policy revisions and is rechecked inside the application transaction.
Resuming permits future import processing to book current clean plans; it does
not immediately apply every existing Pending suggestion. Optional measured-rule
switches and withheld audit samples do not gate enabled import-clean booking.
Each application still uses `suggestions.review` or `suggestions.review_batch` and records automatic
authority and its policy revision in Automatic history.
Changing a booking policy never turns an old transaction-only receipt into
proof of spending; regenerate and revalidate the unbooked work.

Wrong feedback preserves the original Assessment, automatic application receipt
and booked records. It records a review, not an undo or a repair request for
already-booked Purchases, Expenses or allocations. The next suggestion run uses
the existing current-evidence rules: eligible field questions can be reassessed,
while an unchanged rejected answer is withheld from automatic application.
An unchanged rejected statement suggestion remains rejected. Changed evidence
may produce a new suggestion; there is no historical correction pass.
Shared correction coordination explicitly holds semantic repair for
`statement_transaction` and `transfer_pair`; these families have no supported
ready plan. Source amount/withdrawal correction requires its own current source
proof and never grants authority for kind/category changes or transfer re-pairing.

Mail preparation validates source kind, owned original identity and exact
checksums before any paid attribution or relationship judgment. Admission
decisions cannot repair altered bytes; the writer repeats those checks and
requires roster membership inside its transaction.

Shipment intake shares `recordShipmentEvidence` across structured confirmation
extraction, linked `purchase_import.mail_resolve` package packets, and standalone
`shipments.record`. Import and reconciliation resolve a verified retained Email
to its public EML-code and the accepted Purchase to its PUR-code inside their
existing transaction. Attachment extraction also revalidates the retained
attachment checksum before recording its parent Email source. Tracking-page
intake retains URL, stable external key, offset capture time and literal
content. Browser order extractions keep their package facts in the accepted
extraction; callers record a tracking capture explicitly through
`shipments.record` when they have the original page content.

Interactive SMS export intake uses `source.kind: "sms_export"`, retaining the
literal message content, export filename, sender, message time with its known
precision/timezone, offset capture time and stable per-message external key.
The key is member-scoped and independent of export filename; replay retains one
capture, while changed sender, message time or content under that key is refused
for review. This household's SMS timestamps use `America/Los_Angeles` with the
dated PST/PDT offset. Every new observation requires a calendar date. When an SMS
does not state a separate event time, use its notification date at date-only
precision; preserve forecast wording without asserting a completed scan.
Only explicit package identifiers establish a package; neighboring messages,
grouped delivery notices and opaque short links do not establish a match.
Keep unresolvable notices outside shipment intake until their package is proven.
Unattended Mail import cannot submit SMS exports.

Interactive scripts can use the existing CLI login and `cubby call
shipment.record --json-body '<JSON>'` to send the same evidence packets over
the authenticated HTTP API. Omit MCP's top-level `action` from the request body.
Read back with `cubby call shipment.timeline --json-body '{"shipmentId":"SHIP-4K7MN"}'`.
Reviewed corrections use `cubby call shipment.edit_observation --json-body '<JSON>'`
with the current observation ID from the timeline, Shipment reference and a
partial patch. This is the same ownership-checked, revision-preserving writer as MCP.
The CLI retains its credential locally; scripts do not export or print it.

Shipment purpose is direction relative to the household: incoming, outgoing or
unknown. New SMS packages default to incoming; member eBay sales and purchased
postage labels (including Shippo) are outgoing. Explicit member classifications
use generic audited Shipment updates and survive evidence replay. Replacement
and return details remain in source evidence. Retained extraction purpose text
is immutable historical evidence: retired fulfillment categories establish no
direction, so their live package projection is unknown. Extraction JSON,
fingerprints and durable preparation receipts remain unchanged.

Relevance routing retains actual recipient parcel notices from vendors, carriers
and Shop even when no merchant, order, amount or Purchase is known; shipping
promotions and scanned-letter digests remain unrelated. A Shipment is one
package with optional Purchase association. Unmatched
packages retain their Email or page source with no invented Purchase. A Shipment
source capture protects its retained Email original from unrelated-mail disposal,
including when no Purchase association exists. A new
trackingless package requires a stable source package key and distinct-package
evidence. Carrier identity uses Vendor, preserving literal carrier wording and
structured handoff tracking pairs. Observations retain raw status, location,
source event keys and exact time precision/timezone. Use the source notification's
date when no separate event date is stated; ingestion/capture time does not
establish a historical event date. Label creation and vendor-shipped
reports do not establish carrier possession. Repeated source observations use
the shared writer's idempotent path; conflicts remain evidence.

Carrier resolution uses ordinary Vendor identities through unambiguous names and
aliases. Service wording stays in the source evidence rather than creating another
Vendor. Never create a Vendor from a tracking-number
prefix or mistake a merchant, broker or label platform for the delivery carrier.
Unknown names remain useful source evidence without inventing a carrier identity.
A merchant `Delivery:` field holding a short uppercase code names no carrier: one
code can appear beside parcels of different carriers, so never alias it to one.
When that field is the code's only mention in the retained source, intake clears
matching carrier hints, including a stale Vendor reference, on the package, extra
references and new observation events. The value ends at its line, a separator, a
table column or a following tracking, carrier, order or status label; other wording,
as in `Delivery: ZQX Ground`, stays ordinary text. Source keys, fingerprints and the
capture keep the submitted wording, and a re-extraction without the hint keeps the
package's binding through its tracking number. Another mention in the source leaves
the code to the ordinary rules, so a labeled carrier claim survives; a `Delivery: UPS`
notice with no other UPS mention stays unknown until other source evidence names the
carrier.

The extractor's normal carrier fields populate a new or missing assignment.
Optional `carrierClaims` carry exact reference/name/service/role hints and retained
quotes or links; they are not mirrored into a carrier-specific Assessment ledger.
Evidence variants emit provider-compatible `anyOf` in extraction output schemas.
Intake also reads positive carrier/tracking statements and independent links
straight from retained source captures, so a new receipt or proof index is not
required to resolve a historical Shipment.

Clear package/reference-specific source attribution can correct a stored carrier,
regardless of who originally set it. Ordinary member edits use `entity.update` and
its guarded bulk writer, commit alongside other submitted fields, and appear in
normal audit history. They do not create a permanent automation lock; setting null
leaves a missing carrier that later source evidence may fill. An edit also drops
extra references the new primary covers, and the replaced carrier does not become
a handoff. A member can also remove a false extra reference through `entity.update`
with `extraTrackingNumbers` patch items `{op: "remove", key: {trackingNumber,
carrierId}}`, so a stale client cannot drop a reference it never saw. A missing key
refuses the whole update, including submitted carrier and purpose changes. The field
has no replacement, add or bulk form, keeps the same lock and audit history, and is
refused for automation; an edit that changes nothing writes no audit row.
Source evidence that explicitly establishes a removed reference can restore it.
Carrier resolution has no machine/member ownership classification,
assignment receipts or audit markers. Automated source correction still uses the owning Shipment writer rather
than submitting unverified carrier edits through generic CRUD.

A correction requires positive attribution for the exact reference: a complete
carrier/tracking statement, carrier field or shipped-via statement with a labeled
reference. Clipped, conditional, negated or unrelated branding is insufficient, as
are dates, greetings and links laid out above a tracking label, which are not
carrier names and cannot create a conflict.
Retained Email links must have an exact reference on a supported carrier route;
constructed tracking-page URLs, lookalike hosts, unresolved redirects and
multi-reference links do not establish an assignment. Current link coverage is
UPS `/track` and FedEx `/fedextrack` or `/apps/fedextrack`. Image-only/PDF labels
without retained text remain available for review.

Conflicting explicit source claims remain generic Problems because they may
represent a handoff. Read existing captures for primary and additional references,
including held/unbound captures, before first creation and later association.
Compare complete source-event periods within the existing inclusive 60-day rule.
History dates use current events naming the relevant reference, never another
package in the capture; claims without associated event dates remain conservative.
HTML link references participate in source discovery before exact-link validation. Corrections keep the existing Shipment lock,
revision fence and deferred identity constraints, and never merge collisions.

Source-package bindings, occurrence identities and original fingerprints stay
unchanged. Replay recovers the existing binding from its reference when an alias
changes a fallback key, and from a source key respelled within that same source
(case and punctuation). The same label from another source stays separate, because
generic labels such as an origin state recur across unrelated orders. It follows that package's current assignment unless the
source establishes a correction; an unsupported old guess cannot become an extra
handoff reference. Distinct known-carrier handoffs and original captures remain.

Carrier format checks stay as small code-owned rules matched against Vendor names
and aliases. They supply advisory context in existing source/identity review
findings, never select or exclude a carrier, reject useful evidence or reduce
quality scores. The [UPS tracking FAQ](https://www.ups.com/us/en/support/tracking-support)
explicitly includes 12-digit numbers, T/1Z/9-digit forms and freight/Mail Innovations
exceptions. [FedEx Ship documentation](https://developer.fedex.com/api/en-us/catalog/ship/docs.html)
describes 12-digit references, longer barcode encodings and Ground Economy dual
identifiers. Twelve numeric digits therefore match both; unsupported format means
outside the small catalog, not invalid. No exhaustive catalog, checksum rules,
regex database or live carrier lookup is added.

Carrier/identity findings reuse generic Problems: Shipment when known, Email for
owned mail, and the acting member LedgerParty for unresolved non-Email sources.
No speculative Shipment is created for a finding. Unlinked logins retain sources
and receive unresolved outcomes without a member-scoped finding. Publication
preserves dismissals for unchanged evidence. Legacy review is a one-off read-only
maintenance activity using retained sources, not a permanent carrier audit command
or public operation. Detailed reports remain private; review does not publish
findings, replay imports or apply corrections.

Shipment lists and details show First event, Last event, Event span and Events.
These read the reconciled, non-superseded tracking timeline; distinct retained
occurrences count even when their time is unknown, while clear duplicate reports
count once. Observation first/last-seen and capture times are never endpoints.
The span stops at the latest dated event, not the current time. One dated event
has no span. Dates display in the household timezone for exact events and retain the stated day for date-only events.
Date-only endpoints use whole household calendar days; two exact endpoints
use elapsed hours. Valid local timestamps establish their literal calendar date,
even when their timezone is unknown; they do not establish exact elapsed hours.
Historical unknown or unparseable times remain readable but cannot be written as
new event times. One dated event establishes both First event and Last event.
All four list columns sort across the full population before pagination.

Shipment quality reads the same distinct, current event population and treats
valid local timestamps as calendar dates, matching first/last and span summaries.
Historical unparseable local values remain unknown. Its weighted
checks are multiple events (10), carrier possession or movement evidence (30),
explicit delivery evidence (30), event span strictly greater than one day (10),
known shipment and delivery dates (10), and consistent chronology (10). Fewer
than two distinct events caps the score at 25. Label creation and vendor-shipped
notices do not prove carrier possession; in-transit, out-for-delivery and delivery
attempts do. Superseded observations and capture/first-seen times never fill gaps.
Date-only milestone evidence is sufficient. Delivery reports conflict when their
known time ranges do not overlap, or delivery is earlier than the first known
carrier movement. A date-only report covers its household calendar day, so an
exact delivery time within that day agrees. In-progress, same-day, cancelled and
returned records can remain incomplete under these evidence requirements.
Images, notes, Purchase association and source count do not affect this score.
Record quality, list quality sorts and filters share these checks.

Source package identity is retained separately from event versions. Identical
tracked packages across lifecycle Emails match normalized primary and additional
tracking references without requiring a Purchase or a known carrier. Current,
non-estimated source-event dates must fit one inclusive 60-day period. Instants
use the household calendar day; date-only and valid local clocks retain their
literal day. Import dates and cached summaries never establish identity. A
retained Email's received date or exported SMS's sent date supplies the identity
day when its observations have no non-estimated event date; this does not change
the observations, their provenance, or delivery milestones. A
tracking reference can be reused after a gap greater than 60 days, but nearby
evidence cannot transitively extend an existing period past 60 days.

Conflicting known carriers, Purchases, multiple candidates, unknown event dates,
and separate-package claims stay unresolved: intake retains the literal capture,
returns `unresolvedPackages`, and publishes an Email review finding when the source
has an owned Email. It creates no speculative Shipment for that packet.
`distinctPackageEvidence` never bypasses tracked identity matching. A new Email,
item list or status change alone does not establish a separate package. Trackingless packages still need
a stable source package key and distinct-package evidence. A source key is
extractor text, so across sources it never establishes identity alone. A packet
joins an existing Shipment only when both retained Email originals link the same
parcel on a bounded vendor route that names one (Amazon's package tracker, by order,
shipment and package index), both keys name that parcel and respell each other, and
exactly one live candidate fits one identity period with no direction, member or
Purchase conflict. Candidates that do not fit are no rivals: a parcel id reused in a
separate period joins only that period's Shipment. Several that fit stay unresolved
under the rule above. No proof or no fitting candidate stays separate. Neither outcome
refuses tracked siblings. Equal item lists never prove a parcel: two boxes can hold identical
lists, and a source can repeat its order's items, while Amazon can also renumber one parcel
between its Shipped and Delivered notices. A fitting Shipment under the same order and shipment,
without exact link and key proof, whose notice links a single parcel of that shipment and states
the same item list of at least two distinct lines, therefore holds the packet under the rule above,
even as the only candidate or beside an exact match. Period, direction, member and Purchase filter
candidates first. A pair confirmed by other evidence, such as unique units on the order, is a
manual repair. Other lists, one line, grouped notices and another order stay separate as before.
Proof never comes from counters, origin labels, box numbers,
order numbers or other vendors' ids, however opaque, from tracking pages or SMS, which
retain no independent link, or from an unverified wrapper such as Amazon's `/gp/f.html`.
Identical unkeyed source rows retain their multiplicity; replay updates the same
occurrences. A keyless identity hashes the submitted wording and carrier hints, so a
re-extraction of byte-identical source content can revise an occurrence: exactly one
unmatched observation and one unclaimed occurrence retained from that capture must state
the same kind, time, forecast status and tracking reference, without conflicting places.
The new version keeps the original occurrence key beside its own fingerprint and supersedes
the old version, whose identity and fingerprint stay retained; a member-reviewed revision
stays current. Several same-day candidates, or new source content, stay separate events:
wording never proves that two reports are one. Rows that were already duplicated stay as
they are until an explicit correction.
Native event keys scope changed versions to their source package.
A later A → B → A report retains a third version, while stale captures cannot
replace a newer current version. Every supporting capture retains membership
with its observations, including unchanged events in changed page snapshots.
Page content is retained and hashed without trimming. Email captures retain
their original content alongside the verified Email reference and checksum.

Deferred database constraints enforce nearby tracking uniqueness across primary
and additional references and validate the final current evidence period. Writers
share the shipment transaction lock; a single revision row additionally forces
stale snapshot transactions to retry. The migration preserves existing duplicates
unchanged for explicit cleanup; new identity/reference or event changes must
satisfy the guard. Unrelated Purchase, purpose, notes and unchanged replay updates
remain available on legacy records. Undated references require review before
assigning another shipping period. Consolidate Shipment duplicates before merging
carrier Vendors, whose reference rewrites must also satisfy identity enforcement.
Confirmed duplicates are merged as a group in one transaction, keeping the oldest
record and retaining notes, missing carrier identity, observations, capture
memberships, source-package bindings and member-reviewed Purchase decisions.
Intake and merges consolidate tracking references by normalized number and carrier
identity, ignoring carrier-label differences. Extras omit references already
covered by the primary number/carrier and unknown-carrier copies covered by a
known reference. Distinct known-carrier handoff references and original source
wording remain retained.
Conflicting known directions or Purchase decisions require correction first.
Reassigning the last source package merges its empty former Shipment into the
target and inherits the same Purchase-decision and direction preconditions.
Old identities retain their merge destination; writes require the current
reference and the specialist timeline can follow the saved destination.
An interactive member can retire a source record that is not a physical parcel,
such as an empty template row, with
generic Shipment deletion. Never merge such a record into one real parcel. Its
observations, capture memberships and source binding stay on the retired identity.
Replaying that binding reports the package and restores nothing, while sibling
packets in the source still apply. A trackingless packet under a key that source
has never bound is reported the same way, because re-extraction can rename a
retired template. A new source naming a retired tracking
reference starts a Shipment, since only that source's binding records the decision.
Explicitly naming a retired Shipment refuses the whole record call; it does not
restore the row. Retain real multi-parcel groups when their observations cannot
be assigned to individual parcels without losing the group-level meaning.
Tracking pages cannot use notification-received dates: only retained Email or
SMS notification timestamps can support that fallback.
Tracking reports show the source Email's received timestamp when the event time
is unknown, labeled as Email receipt rather than an observed event time. This
display fallback does not replace retained event time or enter milestone duration
calculations.
The reconciled history uses the shared records timeline and date formatter,
including relative age. Each row exposes its normalized event status alongside
the original source wording and links. Retained observations remain available
behind a collapsed, labeled records disclosure on web and native; formatting
never changes their timestamps. Shared report times distinguish instants (with
relative age), date-only values, literal local times with known or unknown zone,
and unknown event times with a separately labeled Email receipt fallback. Every
supporting Email and tracking-page source remains navigable.

Explicit Purchase attachment or detachment is a reviewed decision that replay
cannot override. `shipments.reassign` moves an incorrectly associated source
package and its observations; later replay follows that corrected binding.
`shipments.merge` uses the shared Entity redirect registry, preserving the old
SHIP-code for reads while refusing writes through it. Carrier references in
structured extra tracking numbers follow Vendor merges, while source wording
and historical observations remain evidence.

The extraction schema accepts optional `allShipmentsDelivered` only to decode
historically accepted raw extractions without rewriting their literal evidence
or fingerprints. New model output requires structured `shipments`. No writer
or reconciliation action reads that boolean to create packages, mark an order
delivered, file receiving prompts or receive stock. Existing receiving findings
remain reviewable historical work. A delivered package never establishes that
all packages in its Purchase were delivered. Shipment writes create no
Expenses, settlement allocations or inventory receipts.

Email agents route package observations through `shipments.record` and use
`purchase_import.mail_resolve` for association/disposition; linked resolutions can include
per-Purchase packets atomically. The claim prepass settles only confident unrelated mail; related lifecycle
and duplicate confirmation originals reach the agent for package extraction. Historical retained-Email replay is a
separately requested `purchase_import.email_import` operation, not an implicit deployment job.

`finance.converge` also retains its verified financial-mail convergence path.
The server rechecks posted transaction identity, stable provider references,
live account funding and exact Vendor identity. An existing Purchase requires
an accepted allocation or retained financial Email association plus its
Purchase link. A sole nearby amount/date candidate is advisory. Creating an
orderless aggregate requires genuine spending evidence; transfers, repayment,
refunds, reimbursements and incoming payments do not enter this path.

Financial identifiers are namespaced by provider. A copied payment ID alone
cannot connect an Email to a bank or Monarch record, even if amounts and labels
agree. Without a host-verified namespace, automatic reuse requires a current
member-accepted association for that exact Email, checksum, transaction and
reviewed account. This applies to financial-only evidence as well as booking;
otherwise keep the proposed association in review.

Replay compares accepted transaction, account, allocation, Purchase and full
Expense lineage. Changed accepted facts require review. Adding newly accepted
financial Email provenance refreshes the fingerprint only after the prior
accepted facts pass replay validation. Verified exact
aggregate-to-itemized replacement refreshes that lineage through the normal
reconciliation writer. Candidate ranking considers the full bounded set of
20 candidates, including differing merchant names and dates, without granting
automatic matching authority. Split proposals preserve existing edges;
`finance.allocate_settlement` refuses a stale prior allocation graph.
The browser reopens settlement review with fresh candidates and their accepted
splits. Allocation writes use the catalog mutation's cache invalidation; the
dialog does not issue a second invalidation after the same accepted write.

SpendingCategory is independent of ProductCategory. Explicit Expense categories
win; Product Category mappings and eligible merchant context precede Purchase
fallbacks, as defined by [spending classification](spending-classification.md).
Itemization expectation resolves
from transaction/Purchase overrides, Vendor, then spending category, and decides
whether a Purchase should be itemized. A Vendor's explicit value wins; otherwise
its order evidence supplies it (an online account expects item lines, no order
evidence expects none), and receipt-only or unrecorded evidence implies nothing,
so the Vendor reads Unclassified and its Purchases fall through to the spending
category; a primary document (receipt, invoice,
order confirmation, sales order) makes itemization expected whatever the
policy. No policy requires a document: attachments are optional evidence and
never a gap. Itemization is derived from the lines, not recorded: at least one
live, incurred principal `item_line`, no `allocation` line, and every principal
line whose Product is expected links one (services, tax, shipping, fees and
discounts never need one). A lone productless goods line is a lump.
Unknown category Product expectation also admits principal item lines to
Product-resolution and quantity research; it does not silently exempt them.
Explicit `not_expected` / `not_allowed` policies, services and allocations
retain their exemptions. Coverage keeps its three-valued policy status, and
research admission does not assign a spending category or copy a Vendor default.
Existing lines are re-evaluated by the normal stored-derived drain after a
rule-change migration marks their Expense quality and Purchase quality.
Totals stay with paperwork and settlement reconciliation. Itemization, Product resolution,
and Expense booking have separate coverage; a charge is itemized only when
every Purchase it settles is.

Itemization reads first materialize only the requested Purchase's live Expense
rows, then apply each line fact's eligibility policy. Future and unclassified
rows remain available to the facts that inspect them. This avoids rebuilding a
whole-corpus null-Product bitmap for each Purchase without changing policy or
leaving the statement's snapshot.

Gift and previously-owned Product provenance needs no purchase proof.

Free rewards and coupons reduce the incurred price: record a signed negative
Expense with `lineKind=discount`, its receipt description, and retained source
evidence. For example, gross $201.57 less a free $5 reward is $196.57 owed and
paid. Purchased gift cards or store credit are payment tender, not another
discount. Do not subtract a reward again when the receipt's line amounts or
net total already include it. Preserve literal stated receipt totals; correct
a total only when the receipt establishes that correction. Ambiguous reward
or tender evidence stays unresolved; never change an amount to force a match.

Settlement queue work waits through two complete Monday–Friday days after its
start date, in America/Los_Angeles, without a holiday calendar. Friday evidence
is awaiting posting on Tuesday and becomes investigation work on Wednesday.
The grace ends at household midnight after the second following weekday;
calculating that deadline takes the same work for recent and historical evidence.
Use the effective transaction date, then Purchase date when no transaction
exists, then first observation (`createdAt`) only for undated evidence. A
reimport never resets dated age; an old dated record imported today is already
actionable. Recent Purchase settlement discrepancies and missing settlement
evidence from the declared unsettled view carry `awaiting_posting` in
reconciliation, fenced by source and tender authority; unmatched account-transfer
counterparts do too. Counts and kind filters use that state before paging, while factual
amounts and data-quality discrepancies remain unchanged. Independent research
gaps remain research. Aging calls for investigation, never an inferred defect
or permission to fabricate a missing charge or transfer leg.

Category policies apply to the assigned category, without inheriting a parent
policy. An explicit `unknown` Purchase or transaction override also stops
fallback. Reviewed reimbursement purpose can support the original spending
category; a payment provider name or credit direction alone cannot. Suggestions
use saved linked Purchases, signed Expense lines, and Products, and remain
proposals until reviewed. Native editors request the same backend inference:
policy and create-form choices change the draft; saved finance categories use
the audited atomic Apply command and preserve other unsaved edits.

Vendor paperwork excludes reimbursement Expenses; net spend includes their
signed costs. Booking a vendor refund checks negative principal Expenses and
prior vendor settlements. Discounts cannot be reused as refund evidence.
Partly covered transactions require individual line review rather than
silently recording the full credit twice. Corrections can move an unchanged
aggregate reimbursement to its original Purchase or retire an unchanged
aggregate and attach its bank evidence to a reviewed transfer. Edited,
itemized, or source-claimed lines require individual review.

## Invoice-to-paid-order identity correction

A draft invoice and its completed order can name one economic event with
different identifiers. Original paperwork must establish that relationship;
matching amounts, dates or items alone cannot. The generic Purchase merge still
refuses distinct order identifiers. Never clear or rename them to pass that guard.

An explicitly authorized data-only correction may use the
[maintenance exception](agents/domain-rules.md#production-changes). Its reviewed
transaction locks and fingerprints both Purchase graphs and owned source
families, accounts for every live line and payment, and names each duplicate
Expense's survivor. Resolve classification, Project and attribution differences
from provenance before retirement; an automatic import's defaults do not replace
an established member decision.

Transfer current source-order and line bindings atomically with retirement.
Keep source owners, keys, checksums, original extractions and immutable
observations unchanged. Historical subjects require the existing durable Entity
redirect lifecycle. Use the declared edge policies, Expense removal owner and
merge finalization; preserve archived rows, documents, shipments, payments and
member decisions. Do not carry draft defaults into the paid Purchase or mark
independent reconciliation findings resolved.

Exercise the complete procedure in a rolled-back transaction before applying it.
Verify exact redundant spending and acquisition reduction, unchanged stock,
surviving source bindings and unrelated records. Retain the audited identity
decision and line mapping, independent post-commit read-back and inert repair
replay. Replaying the unchanged source must reach the survivor without recreating
spending. An uncertain commit requires read-back before retry; missing ownership
or preservation guarantees leave the duplicate unresolved.

## Financial evidence entities

[Terminology](guide/terminology.md#naming-policy) owns the names; the
[README overview](../README.md#financial-evidence) owns the entity map.
Source transaction records and Transaction imports retain their generated list
and detail routes. Every bank record (`SourceTransactionRecord`) belongs to one
`SourceOccurrence`, its read-only judgment owner for current account/disposition,
selected record, withdrawal and nullable `acceptedTransactionId`. Proven owners
represent bank events; singleton `unproven` owners hold uncertain historical records
without proving identity. Database checks forbid accepted money or a ready state
on an unproven owner. Multiple independent occurrences may
support one FinancialTransaction; one occurrence has at most one accepted owner.

`finance.record` retains immutable normalized observations. Monarch provider
identity requires matching string IDs in retained raw provider/account evidence;
all present identity fields must agree. Otherwise an original collection fingerprint
and positive physical position establish only collection-local identity. Neither
account descriptors, resolved Cubby accounts, equal facts nor legacy aliases fill
missing provider scope. A new unpositioned request without attestation refuses;
a historical request can replay one uniquely retained collection member without
creating identity or money. Distinct identical physical positions stay distinct.

Generic create/merge remain unavailable. Existing judgment edits resolve to the
one occurrence for every observation, including unproven records. Observation
notes and exact reviewed replacement selections stay local. Preserved historical
annotations retain every original decision without copying it into new revisions.
A reviewed replacement names its exact retained observation, with an occurrence
FK when proven. It never copies accepted ownership. No alias-to-transaction
resolver or charge-key aggregation controls current state.

The public number shape is unchanged: source amounts store exact signed bigint
minor units, with checked dollar-number reads for shipped clients. `chargeKey`
is always the judgment owner's opaque `SOC-` handle. `STR-` still addresses the
original bank record. Find uncertain groups through Source occurrence's
`reviewState: unproven` and `supersededByOccurrenceIdPresenceFilter: none` filters;
retired consolidated reservations remain readable as history. A non-null owner
never grants financial authority. Original v1/v2/v3 references
remain evidence aliases. Fresh source acceptance uses an SOC handle and rechecks
its ready state, head, live target, exact amount and account. Old successful
operation receipts replay before fresh guards; uncommitted legacy-reference
applications require a new preview.

Unproven identity blocks automatic acceptance/correction, with money unchanged.
It creates no new member task for missing source proof. Original evidence and
existing actionable member review remain retained. `matchState: held` blocks automatic actions for unresolved identity, historical ownership, or a retained accepted reservation whose transaction was deleted. Summary splits heldHistorical from heldNeverMatched; a hold without a historical link may still be unbooked spending. `historicalTransactionIds` lists those retained links explicitly; it never supplies accepted ownership. Existing SourceRecord updates accept `identityResolution` only as an explicit reviewed judgment, with expectedDisposition, the observation fingerprint, expected owner version, accepted owner, complete live historical transaction set, resolved account, explicit open/ignored judgment and note. Choose distinct, accept_existing, or assign. The transaction is audited and preserves explicit ignore decisions and original
aliases. `distinct` and `accept_existing` promote an unproven owner in place.
`assign` consolidates a complete eligible unproven, positioned or reviewed owner
into a provider owner, keeping the provider's selected record and transaction
contents. Both versions, reviewed facts/history, account, amount and financial
judgments must agree. Conflicting direct historical transactions or provider IDs
refuse; another owner's exact replacement reference must be resolved first.
An existing accepted link may transfer after explicit review. Retirement clears
the old head and accepted link, retains its identity reservation and audited
preimage, and records released acceptance as tombstoned evidence. Intake follows
one consolidation reservation directly to its provider survivor; ordinary replacement
edges do not redirect intake. Remaining overlaps keep the provider held. Bulk
moves to one target must reread its version between commands.
The survivor retains the latest observation time across both groups. Deleting
the last live record of an unproven group retires that group while retaining its
original decisions and evidence.

Financial suggestion dismissal applies to the exact current recommendation
fingerprint or unchanged evidence fingerprint. Label-only revisions preserve
the dismissal; changed evidence or recommendation policy may produce new advice. Retired suggestions and
legacy aliases never propagate dismissal to another bank event. Explicit financial
ignore decisions remain authoritative; presentation feedback is not an ignore.
Exact import replay never submits an identity or financial judgment.

Suggestion record reach is declared per family with explicit affected roles and
forward/reverse SQL. Statement reach starts at its primary bank record, follows
occurrence siblings and collection memberships, and does not depend on a retained
legacy charge-key string. One and many-record badges use the same bounded record
expansion. Work retains the narrower account-owned statement reach.

Whole-list projections materialize retained historical closure before applying
root predicates. List filters use the generic whole-list value set; state sorts
use uncorrelated membership sets. Page bindings first collect requested roots'
alias keys, then all matching observation siblings and their observation/occurrence
evidence. The non-unique alias lookup index keys `(source, value)` across kinds
and tombstones; provenance and ownership uniqueness remain separate constraints.
They follow exactly one sibling hop, including siblings outside the page and
retained alias tombstones. One statement-local relation supplies live
historical bindings; the occurrence ownership fence reads its direct aliases
separately, so a fence-only occurrence cannot disappear with the presentation
frontier. States and historical links load in one batch rather than
a scalar subquery per observation. They preserve the point acceptance
check's live-binding/transaction rules and retained alias provenance. Historical
links remain presentation and negative ownership fences, never accepted ownership.
The page binding owns projected match state. The main SELECT omits its redundant
scalar expression; filters, sorts and groups retain their declared state SQL.
Historical closure maps relevant alias keys to observations before expanding
transaction pairs, avoiding repeated record lookups for every historical link.
Both alias routes retain their tombstones and deduplicate the same complete
observation/transaction set before ordering the public codes.

Source-record display media shares one settlement expansion across its image
branches. It fences only requested observation roots and retains all of their
accepted and historical transaction links, including retained alias tombstones.
Historical binding rows join live transactions once before the page's alias
lookups, avoiding repeated binding scans. These are read projections in one
statement snapshot; they never establish accepted ownership.

Transaction imports are read-only outside intake. Neither generic create,
update, merge nor delete changes their metadata or membership. Intake owns
resumption, count/completion updates and source-confirmed withdrawal; deleting
a collection is not a reconciliation operation.

Generic deletion of a source transaction record blocks while a live predecessor
supersedes to it or an accepted FinancialTransaction source reference claims it.
It preserves those relationships rather than detaching or cascading evidence.
Resolve the accepted relationship through its owning workflow before retrying;
a withdrawal is recorded evidence and never an instruction to delete history. Deleting a current revision does not promote an older one; replaying an older import still respects the deleted head’s observation time.

Use `entity_read.get`, `entity_read.list` and `entity_read.search` for records,
imports and their declared projections; use generic entity commands for judgment
updates and guarded deletes. The specialized summary and drift reads remain
workflow computations. `record` owns intake and `previewSuggestion` owns the
read-only review projection. The former custom list, import roster, update and
delete APIs have no separate replacement surface.

`entity_read.list` exposes exact stored-value filters for `chargeKey`,
`providerTransactionId` and `providerAccountId`. Each accepts one value or an
any-of list; different filters intersect with the existing `source` filter.
Use the provider account scope alongside a provider transaction ID when known:
the same provider ID in distinct accounts does not establish one charge.
The existing `current` boolean selects current (`true`) or historical (`false`)
observations; omitting it returns both. Generic lists still exclude soft-deleted
observations, including deleted heads; they do not promote an older revision or
prove complete retained history. These filters select evidence and grant no
identity-resolution or financial-admission authority.

`finance_read.drift` reports possible overlap between distinct charge keys,
not proven duplicate money. Equal source/account/date/amount fields and row
creation order cannot establish occurrence identity or revision direction.
Its default shared-membership exclusion preserves normal export coexistence;
historical mixed membership still needs source proof. Inspect retained provider
identities, revisions, collection memberships and accepted settlement references
before guarded reconciliation. Truncation and an empty candidate list do not
prove historical completeness. The read grants no bulk supersession authority.

### Identity and money measurement before a financial cutover

Before changing financial identity or money representation, measure the full
retained population, including deleted observations. Report proven identities
first; provider-ID counts and charge-key groups are candidate partitions.

- Provider proof requires the source, retained provider transaction ID and
  attested provider account namespace. Compare both IDs with original provider
  evidence. A resolved Cubby account, matching descriptor, unique alias or null
  scope cannot supply missing provider scope. Measure current-head, judgment,
  account and ownership conflicts separately, including supersession.
- Physical proof requires a positive position in the original collection,
  matching source and retained original membership. Compare the frozen v2
  digest with source, original collection fingerprint and position; count
  position collisions. This proves collection-local identity only. It never
  deduplicates separate imports or orders provider revisions.
- Count unproven observations separately. Keep their money and provenance
  unchanged and block automatic acceptance/correction where identity is
  required. Do not manufacture member review tasks for missing source proof;
  retain existing evidence-backed review for judgments a member can make.
- Enumerate all historical accepted alias bindings as evidence candidates,
  including tombstones. A sole live alias owner is not proven accepted
  ownership. Check each promoted owner against complete retained bindings.

Audit settled amounts separately from unit prices, fractional quantities,
weights and provider usage charges. Classify null, finite exact decimal cents,
near-cent floating noise, genuine sub-cent, non-finite and minor-unit overflow
values. A diagnostic tolerance classifies noise; it never authorizes rounding
stored money. Include Purchase totals, Project estimates and receipt-payment
amounts in the field inventory. Require exact IEEE round-trip equality between
the original double and proposed integer cents divided by 100; `float8::numeric`
can hide stored noise. The follow-up audit found three noisy Expense costs;
they remain unchanged and need original decimal evidence before conversion. Include
monetary values nested in retained JSON.
Compare proposed conversions with the existing JavaScript cent semantics and
retained original decimal evidence before migration. Successful scalar-column
classification alone does not establish full JSON, Rust or native wire coverage.

Choose a reconciliation cohort covering existing-spend links, missing
aggregates, recorded attribution, source revisions and unresolved identity.
Record elapsed time, model usage, round trips, separate mutations, evidence
volume and committed checkpoints only where observable. Mark unmeasured
workflow costs explicitly; population counts and relation sizes are not
performance baselines. Observe the existing financial refresh through terminal
results before coordinating a migration with the release owner. Never change
its tables under running statement generation.

## Normalized financial evidence intake

Claude/Codex use the [financial-evidence-import skill](../.agents/skills/financial-evidence-import/SKILL.md)
to read Monarch MCP or parse Monarch, Mint, Copilot and Apple Card exports
locally. Cubby accepts normalized observations through `finance.record`;
the application has no financial CSV parser, upload, mapping, preview/commit,
native file picker or CSV CLI. USDA parsing and expense report exports are
independent of financial intake.

MCP server guidance routes financial evidence through this intake and the
financial-evidence-import playbook. Recording evidence delegates downstream
matching, Suggestions and guarded booking to Cubby; a client does not follow
intake with a separate transaction-create, attach or Expense-booking sequence.
Collection runs through the local skill with the member's connected Monarch
and Cubby MCP tools. This path does not require a Worker-owned Monarch
connection. Any recurring execution uses that same skill on an explicitly
authorized host with verified credentials, after historical reconciliation;
the skill itself installs no scheduler.

Keep every observation and original description. Reobserving equal normalized
facts under a proven identity can reuse their observation and first providerData
annotation while adding collection membership. Each new membership freezes a
request fingerprint, so exact replay cannot rewrite that collection's input.
Historical unknown positions/fingerprints stay null; never infer ordinals across
imports. Fact/request hashes establish equality only, never event identity.

A changed normalized fact appends an observation. Arrival time, current flags,
lexical codes and collection timestamps cannot prove provider revision order.
Unknown ordering leaves the occurrence without a selected head and blocks
automatic actions. Explicit reviewed version selection can resolve that hold;
it does not move accepted money. Older collection replay never advances a head.
Zero observations remain evidence and cannot create spending.

Cross-collection positioned overlap stays independent and held when retained
legacy evidence makes its economic identity uncertain. Scoped provider identities
in distinct accounts stay separate. Aliases may widen candidates or block unsafe
automatic work; they never establish accepted ownership. Complete retained
bindings, including tombstones, must support any ownership promotion.

Acceptance and ordinary financial edits reserve command keys, then lock sorted
occurrences before settlement-party, Purchase, FinancialTransaction and Expense
rows. The source owner and money effects commit together. Graph expansion or
stale review refuses/retries the DB-only snapshot; model calls stay outside.
Existing successful receipts precede these fresh checks. A deleted accepted
transaction keeps its source reservation and cannot be recreated by replay.

Corrections read the explicit accepted FK and independently corroborating
occurrences. Unresolved historical bindings remain negative blockers. There is
no observation → alias owner → transaction account → copied source judgment
loop. Member suppression is read from its existing Suggestion owner, without
copying another current decision ledger into the occurrence.

A collection owns its immutable observation time, declared count and optional
account/date/visibility scope. Chunks resume that collection. Membership is
independent of first ownership, and migration preserves known memberships
without inventing complete historical windows. Completing a source pull
requires exhaustive enumeration and equality between declared and retained
counts, including zeros. A page or visible-only query cannot establish absence.
The skill must identify unsupported accounts, including Monarch connections
excluded by its MCP, rather than reporting them current.

Evidence, memberships, revisions and the existing Sweep's Job intent commit in
one transaction; waking happens after commit. Corrections recheck the existing
automatic spending switch under its transaction lock; pausing it blocks money
changes and retirement as well as new booking. Scheduling failure rolls admission
back. The outer DB-only snapshot write uses bounded retries for serialization
conflicts, including late derived-refresh Job contention, rebuilding evidence and
Sweep admission together on each attempt. Dry runs and unchanged replays create
no work; existing Jobs own interrupted
execution recovery. A new collection can advance observation time without
changing the original source record; `refreshed` counts those new observations
of existing facts. Completed collections reject additional membership. A reappearing
withdrawn charge stays in review rather than silently recreating retired spending. After verified historical backfill, routine
Monarch pulls overlap two weeks; refresh older windows deliberately when needed.

Collection rosters return metadata without bulk-loading retained source notes or
archives. Recording retries read only the immutable collection header, so a large
historical archive does not repeat on every bounded chunk.

Source-confirmed withdrawals require a completed all-visibility account/window
and an explicit recheck. The occurrence records withdrawal and its proof collection.
Old observations cannot reactivate it; reappearance remains held. A later-dated export alone never proves disappearance.

Cubby reconciles accepted revisions in one snapshot transaction. An automatic
amount correction or withdrawal requires the original automatic-decision and
Expense-lineage fingerprints, one unchanged generated lump, unchanged allocation
and member shares, no itemization, claims or attached independent evidence, and
current corroboration that agrees. Amount corrections update the transaction,
allocation and Expense together. Withdrawal retires the generated Expense
through supported writers, voids the transaction and retains references and
history. Edited, itemized or conflicting bookings stay in the existing Suggestions
queue for individual FinancialTransaction/Expense review; recording source
changes never silently overwrites them. A source date revision that changes the
booking's effective funding date requires individual review of dated allocations
and Expenses. Status/date-only refusals remain durable Suggestions even when the
amount is unchanged; supported posting updates may proceed when the effective
funding date stays unchanged. Current evidence that already agrees with the
booked amount and lifecycle needs no write and opens no review, whatever the
booking's decision provenance.

Suggestions remain one per actionable charge. Matching a source observation is
separate from booking Expenses. Existing candidates must be rejected before a
new transaction can be created. Historical collection membership may include surplus or mispositioned evidence.
It cannot by itself dismiss an existing settlement candidate during Suggestions
discovery; ambiguous identity remains review work before new spending. A nearby
transaction (same account, ±3 days) is a candidate only for the same amount, a
matching non-empty description or a matching non-empty merchant; two missing
descriptions are absent evidence, not a match. Descriptor/amount/date coincidence is advisory;
a different source's observation does not become a second charge merely because
its text differs. Existing clean-booking and measured attach rules retain their
own authority and revalidate current evidence before writing.

A repeated statement Sweep keeps labels for the same source and charge key
when the statement model inputs and the candidate identities/model inputs
match, and the recorded label prompt revision is current. Bump
`STATEMENT_LABEL_REVISION` with any statement label prompt or model-policy
change; it retains the deployed revision so existing compatible labels survive.
Observation occurrences, memos, rule/history votes and clean-policy
changes can move the broader evidence fingerprint without requiring fresh
model decisions. Replacement suggestions retain the original model provenance,
copy only the model votes and candidate labels, and recompute kind and clean
status from current rules, history and transfer evidence. Changed model inputs
or candidates retire the old labels atomically with the replacement; suppressed
or settled charges remain excluded. Generation commits bounded batches of
independent charges. Label pages default to 32 suggestions, retaining the shared
512-suggestion ceiling for explicit callers. Identity questions remain batched;
merchant/spending preparation runs in waves of at most 32, with field questions
batched within each wave. The default page admits one spending wave instead of
serializing behind four wave barriers. A single page allowance admits fresh
context-fitting questions incrementally in identity/kind/counterparty/spending
order, reserving spending before the next charge. Compatible checkpoint answers
remain eligible after the allowance is exhausted. Out-of-context defaults consume
no allowance; once none remains, unrendered questions wait for the next page.
Untouched charges retain their complete candidate population and inclusive cursor;
they receive no empty checkpoint, skipped outcome or completion. Started work
settles before publication. RunStep page samples retain selection, discovery,
label preparation (prompt rendering and judgment cloning), decision,
spending-fact, spending, publication and ordered-application wall times plus
database metrics. Ordered application includes no-action prefix validation
and receipt settlement; it must not be mistaken for unmeasured model latency.
Cooperative pages stop admitting new spending work
after 20 seconds, settle started work, and save partial answers before yielding.
This deadline does not interrupt an in-flight provider request. Cache contention
and lookup deferrals remain typed waits through item isolation; they neither
become retained item failures nor trigger uncached model calls. Unfinished charges
resume inclusively. Failed items remain unresolved even after scanning ends;
a completed scan with retained failures is not completed reconciliation.
Complete labels publish in batches of at most 32 charges,
with at most four publication transactions in flight; partial checkpoints remain
per charge. Each completed label retains its own producer, checkpoint, Assessment
receipt and original application order. A failed batch reconciles each charge
through the same locked admission path: committed publications recover their
pending application receipts before testing the obsolete input fence, and finish
retirement before acknowledgement. Recovery does not recreate or restamp labels.
Resumed application receipts repeat that exact retirement check before application,
including recovery from a crash before the after-commit callback started.
Unscoped Sweeps may settle a no-effect receipt prefix whose only stamps are
current import-only rules: these rules cannot execute outside import admission.
Unknown, obsolete and otherwise applicable stamps still end the prefix, even
when a member switch is paused. Import-scoped work keeps regeneration and fresh
individual admission.
Automatic financial application still admits only the original ready prefix,
sequentially. Charges already skipped by the current label page do not split its
ready receipt prefix; they admit no effect and retain their skipped outcome.
Failed, unfinished and applicable-rule charges still stop it.
Statement application and financial booking request only identity output from
their mutation writers when they consume only IDs. The same writers retain
validation, locks, audits, allocations and receipts without hydrating unused
display records. Output selection does not replace fresh financial admission.
Unscoped label passes may complete consecutive no-action receipts
in bounded transactions: lock the exact receipts, verify their charge/evidence,
active pending state and absent rule descriptors, then clear only the proven
prefix through the projection writer. A missing, replaced or rule-bearing receipt
stops the batch even when its rule is paused. Release the locks before ordinary
application and reread the suffix after it. Import-scoped passes retain regeneration
before each admission, since regeneration can introduce actionable rules.
Import-scoped generation and retained generation retries admit at most 32 charges
per page before recording their cursor. These pages regenerate and apply money
sequentially; the smaller bound limits repeated work after interruption. Advice-only
generation retains the 512-charge ceiling. This changes neither financial admission
nor the retained retry population, and provides no wall-time guarantee.
Interruption preserves reusable labels and completed publications.
Retrying failed statement labels consumes only the retained charge references,
one charge at a time, without moving the original population cursor. Each charge
is regenerated under the Run's retained account/date/import scope before its
current label work is selected. Model waits and funding pauses retain that charge;
disabled automatic AI work pauses the retry rather than discarding it. Healthy
charges and later arrivals are not added to the retry population.
Label-page selection partitions positions by whether either original-order component
is retained. Ordinary rows use native timestamp/ID ordering; retained rows keep the
same component-wise overrides. A statement Sweep carries its full account/date/import
scope through hold counting, paging and input inspection as well as label counting,
selection, retries and receipt admission. Hold selection intersects the account filter
with retained charge membership/date before cursor limits; it admits whole holds and
retains every pending settlement reference's evidence. Existing explicit withdrawal
proof is still required for a void proposal; incomplete membership supplies none.
Date and import
filters intersect on retained source observations using the generation identity selector,
including withdrawal imports; the date is the source `statementDate`, not the
Assessment timestamp. Account scope uses live generation-preview resolution in batches,
including stored and accepted-settlement hints; void targets use their live transaction's
account. Both cursor branches apply identity/date scope, full current-evidence eligibility,
cursor comparison and Assessment existence before taking bounded candidate sets.
Account preparation reads only those candidates and continues past excluded positions
in fixed-size batches independent of the remaining output capacity, until the scoped
page is full or the scan is exhausted. Extra admitted candidates keep their original
cursor positions for the next page; only the filled output page hydrates
judgments and checkpoints. Scoped counts traverse the eligible population separately.
Scope follows regeneration and is checked again inside automatic review's serializable
write admission, so valid fresh evidence for another account cannot authorize an effect.
Scoped checkpoints and label publications also recheck the live resolver inside their
serializable write transactions, including batch fallback and committed receipt recovery.
Scoped checkpoint retention runs sequentially within a label page because every new
checkpoint updates the same Job progress row. Model preparation remains batched.
An out-of-scope result preserves existing evidence and paid checkpoints without publishing
or acknowledging that target. Background calls without scope retain their ordinary path.
Both no-action-prefix and ordinary receipt completion recheck that same scope inside
their write transactions, including zero-rule and resumed-receipt paths. Excluded receipts
keep `applicationPending` and their original `applicationOrder`; completion counts include
only IDs admitted by the writer. Account/date scope remains eligible for the no-action
shortcut with this guard.
`run.sweep` and its estimate accept a statement family's optional `importId` as a
TransactionImport shortcode (`TIM-…`). Both resolve the live retained collection
to its UUID before estimation or Run/Job creation; invalid, missing and deleted
references refuse. Account and date filters intersect its retained charge membership.
Selected charges still use current observations from other collections sharing their
identity; unrelated charge identities remain excluded.
This reprocesses retained evidence under existing automatic policies, including
enabled clean spending booking even when the measured attach switch is off.
It changes no rule switches. Account/date scope alone does not grant import-clean
authority. A booking pause still holds spending; non-spending attachments remain
governed by the measured rule. Incomplete collections allow supported positive
processing but prove no absence, withdrawal, reconciliation or completion. A Sweep
changes neither collection coverage nor `completedAt` and records no withdrawals.
Default background labeling remains unscoped. Disjoint
partial work indexes exclude completed labels and keep receipt recovery separate from
ordinary cursor access. Schema-owned family, status and label-work keys stay SQL
literals so generic plans can admit those indexes; household values and cursors
stay bound parameters. No timestamp cast is asserted immutable.
An obsolete Job generation or lease interrupts the invocation; per-charge error
isolation must not turn that ownership signal into an item failure or retry.
Acceptance always validates the current broader evidence fingerprint.

Within one read-only proposal page, spending preparation loads shared account
and transaction metadata, settlement references and allocations once and prepares at most four independent charges
concurrently. The metadata is discarded after that build; label work and
financial application rebuild current facts. Purchase-payment candidates are
selected once for the page's admitted amounts and date envelope. Vendor
Purchase pools, booking graphs, payment rows, category records and category history are shared
only inside that page; per-charge date, amount, refund and explicit-target rules
still select candidates. Payment candidates are indexed by exact amount before
applying each charge's calendar window. Concurrent category lookups coalesce
including absent or deleted categories; a new page and every commit read current
categories again. Requests outside the admitted bounds use the original
fresh SQL selector. Publication retains its own
four-transaction limit and per-charge locks, suppression checks and settlement
rechecks. Rule replacements share batch admission, retirement and publication
while retaining each charge's ordinal and compatible label checkpoint. A charge
with reusable paid labels follows the ordinary writer to rebuild its judgment
from current facts. Generation logs separate selection, preparation, publication and
import-application durations with aggregate counts, without source records.
Transfer generation hydrates eligible transaction seeds once per page, including
known absent seeds. A failed bulk read falls back to isolated seed reads.
Seed selection takes the first bounded keys from each disjoint origin, then
merges them under the existing byte cursor. Statement observations are deduplicated
before that origin's limit; an index on its byte-ordered seed key streams this
work. Date and frozen-population predicates still precede each limit, and count
uses the same admission predicates over the full unique roster.
Transfer and statement-matching previews omit unused advisory Vendor inference. Statement seed preview
batches and each seed's exact competitor pool remain
unchanged; broader preview batches can change duplicate admission. Retirement
and acceptance rebuild current evidence.
Within a preparation page, previews share raw observations for the exact same
file fingerprint and candidate settlement-reference scope, including known misses.
Hydration follows candidate selection and retains historical observation positions;
each call retains its own duplicate-admission input rows.
Preview indexes retain source-scoped reference identity, provider account scope,
file occurrence positions and the original ledger candidate order. Each row's
nearby search still evaluates every transaction on its account in the read pool.
Preview transaction selection joins exact source/reference pairs through a
requested-values relation, rather than planning a correlated OR per reference.
Reference matches remain global across date corrections; live transaction and
reference checks, date alternatives and candidate hydration stay unchanged.
The initial statement count aggregates the same eligibility predicate once;
generation continues selecting bounded charge identities before hydration.
Generation checkpoints depend only on model-free generation and publication;
optional model preparation cannot delay them. Label rounds apply the settled
kind votes before preparing shared spending facts; each charge then uses those
read-only facts with its own advice. The existing field-suggestion batch scope
shares classification catalogs within the round. Each bounded spending wave
uses the existing finite-work decision scheduler and one usage group per
operation to batch category questions after merchant preparation. Each question
keeps its own evidence, cache entry, model routing and checkpoint; all started
work settles before publication.
The spending roster requests only identity, name and parent fields, leaving
unrelated category connections and stock tracking unloaded. Advice and its
spending preview share the same read-only vendor resolution and history.
Vendor history resolves the selected live, nonfuture Expenses through the shared
bulk category policy before grouping; it does not resolve category ancestry anew
for every line or omit uncategorized lines.
Shared preparation failures fall back to
isolated reads, and publication/booking never use the page cache as commit
validation. The later label step retains
ownership of model decisions and reuses compatible durable label checkpoints.
Live source observations have separate source-scoped occurrence and legacy-reference
lookup indexes. Candidate ownership checks retain both reference forms; the
legacy lookup must not scan every observation of the source for each candidate.
Charge pagination applies the whole-charge cursor before aggregating retained
observations, while preserving every observation within each selected identity.
Label selection limits candidate identities before hydrating immutable judgments.
Record-reference inspection expands only requested entity kinds; unscoped audit
reads retain the complete reference set.

Provider account masks retain all supplied digits, including non-card masks
longer than four digits. An account name already containing that mask does not
receive a second suffix. These descriptors participate in statement identity;
normalization must not truncate them into a different account reference.
Historical descriptor spelling and reference strings remain retained. New
normalization must preserve complete masks; a changed descriptor is not grounds
to rewrite accepted transaction identity or an old observation.

### Unlinked spending and ownership exits

An unlinked principal vendor Expense for a selected Product requires explicit
source reconciliation before new itemization. A zero-cost entry with negative
Product quantity records an ownership exit rather than an acquisition; it does
not by itself block a later purchase. Preserve that disposal's quantity, date,
notes and unlinked state while importing the new order's own spending. Unknown
cost or quantity and all other unlinked entries retain the review guard. Neither
this distinction nor receipt import receives stock or reuses the disposal.

### Foreign receipt itemization with USD accounting

A complete non-USD purchase retains its literal currency, descriptions, amounts,
quantities and adjustments in accepted source evidence. Its ordinary item-line
Expenses carry `cost: null`, supported quantities and editable Product bindings.
`ImportSourceProduct.expenseId` gives each original line its canonical acquisition;
no separate item entity is needed. Shipping and adjustments never acquire Products.
An absent quantity stays unknown. Product history can show an acquisition with
unknown USD item cost; neither its cost nor quantity enters USD pricing averages.

A separately supported USD aggregate remains the only booked amount. Source amounts
never enter `Expense.cost`, USD payment evidence or USD sums. Exact foreign source
itemization is present independently of Product resolution; booking is recorded
when the USD aggregate covers the purchase, while USD item valuation stays unknown.
Unresolved ordinary USD costs still make booking partial. Original order and
statement dates retain their respective owners. Import and reconciliation never
receive inventory. Earned but unspent rewards are neither tender nor a discount.

Replay reuses immutable source-line references. Equivalent sources reuse the whole
unpriced roster only when their literal currency, total, ordered lines, amounts and
quantities agree; repeated identical lines use existing Expense references. A new
foreign source beside pre-existing priced item Expenses, an ambiguous roster or
changed accepted facts requires review rather than another acquisition. Ordinary
Expense Product edits and Product merges retain canonical Expense identity and
original source history. Accepted-source Product-only attachment can bind an
existing item Expense without comparing foreign amounts to USD; it cannot bind an
aggregate or change money. Historical missing lines require a reviewed maintenance
repair, not a replay that silently changes accepted data.

Pricing a foreign item through ordinary Expense update is refused. This protection
follows its retained source binding even if its Purchase or classification changes;
coverage separately requires the current Purchase and item role to agree. Later actual
USD itemization uses reviewed source reconciliation: review the complete unpriced
roster together with its USD aggregate, reuse each acquisition once, preserve item
identity and supported quantities, remove the aggregate, and conserve recorded
USD spend and attribution in one transaction. Source-claimed aggregates retain
their explicit financial correction requirements. Original foreign bindings remain
on the reused Expenses, including when revised USD evidence uses the same source
identity; changed monetary fingerprints cannot erase the reviewed correspondence; no exchange rate or per-item USD allocation is inferred.
Foreign refunds and cancellations remain reviewed accounting work. Native foreign
balances, optional USD allocations and automatic stock changes are unsupported.

### Correcting a purchased Product

Correct an imported item's Product through the ordinary Expense entity update.
Create a missing Product through the ordinary Product create first, then set
`Expense.productId` and the purchased quantity. No accepted-source lookup,
original preparation or reconciliation command is required for this correction.
The live Expense owns the current Product. A retained receipt-line reference
lets identifier discovery follow that Product, including reassignments and
clearing the Product; original import Product decisions remain history.
Deleted Expenses and Purchases do not contribute receipt-derived identifiers.
An incomplete order with no Expense retains identifier discovery through its
current generic Purchase/Product association; removing that association removes
the claim without inventing money.
Imports record the Expense reference even when a Product is unresolved. The
migration links older original lines only to unique exact item Expenses and
leaves ambiguous history unlinked. It preserves original records and changes
no money, payments, attribution or inventory. Financial reconciliation retains
its existing review and conservation checks.

Retailer preparation can explicitly target an orderless Purchase. Receipt
itemization that changes recorded lines proposes `reconcile_source_order`
before accepting its headers, attachments, Product bindings or payments. The
writer carries one locked line-admission decision and Expense snapshot through
ordinary line writes; a new Purchase is admitted from an empty snapshot.
The existing source-reconciliation review owns replacement proposals with
original lines, proposed identities, and exact beneficiary/funder amounts.
Approval binds the full proposal and original graph; changed proposals or
edited originals fail. Historical stored `replace_aggregate_line` approvals
remain applicable through their existing reviewed-snapshot consumer.
Photo groups remain editable and require approval before Product and inventory
writes. Imported source claims alone do not establish reviewed itemization.

Prepared candidate reviews preserve their original evidence. New preparations
record exact name/alias equality explicitly. Historical candidates that never
recorded that judgment expose `exactNameMatch: null`, rather than a fabricated
non-match or a reconstruction from today's catalog. Reading a review does not
rewrite its saved snapshot; commit independently rechecks current identities.
An unchanged accepted item identity replays even when its original resolution
was `new`, when money is incomplete, or after its Product merges. A changed
choice or missing accepted binding requires reconciliation review. Equivalent
second sources retain their observations without duplicating canonical Product
association rows; binding an unbound manual item creates the association once. Identifier-collision review proposals publish after the import has retained its Product bindings and finished learning identifiers, so those evidence writes cannot supersede a fresh proposal before commit. The registered identifier remains with its actual owner.

A member-reviewed refund reference from an Email is an
`EmailFinancialAssociation`. It retains the exact Email checksum, the original
account label, the reviewed account and decision provenance; it survives
deletion as history, exposes later account drift, and never writes financial
allocations. `purchase_import.mail_resolve` can link a lifecycle Email to several existing
Purchases through `purchaseIds`.

The contracts above are deployed. Remaining live acceptance work belongs in
[the acceptance issue](https://github.com/nickysemenza/cubby/issues/2137). Deployment, stored fields
and terminal Runs alone do not establish source-specific acceptance: blocked
bindings still need public writer/readback verification, and missing original
preparations remain evidence gaps. Historical restart readiness requires the
Mail import switch and transport/coverage evidence; missing evidence stays
unknown, never reconstructed from current defaults. Continuous financial
processing needs its own acceptance beyond discovery. Existing-Purchase attachment and
accepted-source reconciliation preserve money and stock and refuse ambiguous or
changed original bindings.

## Validation boundaries

`import-order-convergence.integration.test.ts` exercises a Latin square plus
two seeded arrival orders of Gmail, retailer, photo, and normalized financial evidence against
PostgreSQL through
the same writers the routes dispatch: real normalization, persistence,
retailer preparation/commit, photo staging/finalization/review, normalized intake,
booking, finding resolution, and order-mail linking.
The composite `import-order-convergence.spec.ts` browser journey is removed.
`gmail.input-first-import.spec.ts` retains input acquisition, reviewed statement
booking and receipt reconciliation, Product conflict review, and Vendor-to-Purchase
and original Email navigation. Photo review and photo-first journeys retain signed
upload, review approval and persisted image roles. The crowded Problems sample
regression belongs to `run-service.integration.test.ts`; the Gmail journey still
applies the reviewed fix from the Run page.
The PostgreSQL matrix owns the six sampled source orders and exact final Product,
inventory ownership, Expense, Purchase allocation and original source edges.
External classifier/image-description output is deterministic. The combined
four-source browser sequence no longer has a dedicated owner.

The normalized evidence PostgreSQL contracts retain replay, complete-window
admission, distinct occurrences, immutable revisions and monotonic withdrawal.
The MCP catalog regression verifies that dry runs and unchanged replays create
no Runs, Jobs, assessments or money. Financial correction contracts verify
atomic amounts, allocations, attribution preservation and guarded retirement.
Obsolete web/native CSV selection and preview tests are removed with that UI.

`finance-evidence-journey.spec.ts` covers reviewed spending, reimbursements,
corrections, transfer conversion, and refusal after edits.
`financial-booking-review.spec.ts` drives browser review, stale refusal, exact
retry, and altered retry. SQL boundary regressions cover settlement identity,
receipt-policy precedence, quality exceptions, cent-preserving replacement,
and refund capacity.

The Mac runner is documented in
[mac-import-e2e.md](../apps/web/tooling/mac-import-e2e.md). It builds and signs a
separate app identity, uses fixture account/browser state, and records each
exercised boundary independently. A successful build does not establish
native capture, photo approval, or product import. Locked-host or authentication failures must remain failed milestones.
Live Gmail authorization, live retailer changes, and physical iPhone photo
quality remain distinct from deterministic import convergence.

## Migration and rollout

Follow [production change rules](agents/domain-rules.md#production-changes).
Historical backfills must preserve unknown acquisition origin and evidence;
existing bank transactions and Expenses are not automatically reclassified or
booked. Apply the preserving schema migration and matching clients through the
[production migration runbook](runbooks/production-migrations.md). After release,
verify retained observation and import identities, membership and source references,
unchanged spending, an audited judgment edit, and generic reads/connections on web,
Apple and a reconnected MCP session. Local validation does not establish these
production outcomes.

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
first ownership. Multiple observations of one charge return one proposal.
These reads expose served proposals only: an empty result does not establish
complete source coverage or reconciliation, and listing does not refresh or
validate an application. Preview and acceptance retain their current-evidence
guards. Source scoping changes no overlap or financial identity decisions.

Suggestions is the reconciliation workspace: Pending proposals, optional Automatic
decisions audit, and Automatic rules. Source transaction records is the generic
imported-evidence browser; Transaction imports shows the retained collections.
Each import's reconciliation report separates retained-observation match states
from booking coverage for its distinct matched Financial Transactions. Charge
matching includes retained revisions outside the selected collection; repeated
observations do not multiply its transaction counts. Collections can overlap,
so their figures are not additive. Unmatched evidence is outside the booking
denominator, and recorded booking proves neither balanced settlement, source
completeness nor itemization.
Filter the declared evidence projection by account, amount, date and match state
as needed. Several observations can describe the same charge.

Statement review shows Source, Proposed result and Evidence. The read-only
`sourceTransactionRecord.previewSuggestion` (MCP `finance_read.preview_suggestion`)
revalidates the Assessment fingerprint and live
charge before projecting a draft through the same action gates and spending
planner as acceptance. Published review holds, including source lifecycle conflicts,
refuse both preview and acceptance before projecting financial effects.
It writes no aliases or records. The preview identifies transaction changes,
vendor reuse/creation and alias effects, Purchase/Expense
and settlement effects, purchaser basis and the explicit vendor-account state.
Changing a web draft refreshes the reviewed result; acceptance still replans
inside its write boundary. Agents may call the preview to inspect uncertain
effects; a separate `finance_read.preview_suggestion` call is optional, never
acceptance authority or a prerequisite to a supported `suggestions.review`.
The write always validates the current Assessment, application and spending. Explicit MCP review supplying `booking` or `kindOverride`, or choosing
a nonrecommended action, uses `verdict: "wrong"` with
`correction: { present: true, value: application }` and the same `application`.
This includes a Create draft that retains the recommended action but supplies
booking choices. Preview checks financial effects; application also enforces
the verdict and correction-presence contract.
Kind controls apply only to a Create draft; an attachment first uses
Preview new transaction to review that alternative. Provider category is evidence,
not a Cubby spending-category assignment:
retain each provider/category observation, joining other provider charges only
through authoritative settlement references to the same transaction.

Statement attachment also converges spending. A spending result requiring review
blocks attachment even when no transaction fields are selected. For an already
accepted transaction with a separately authorized explicit booking, inspect
existing spending, book through the supported command, then refresh the proposal
against that booking. Preserve the accepted transaction, source references and
allocations. A lineage refusal remains unresolved; never restore Expense values
or member attribution to force attachment. An authorized identity-only repair
must merge the current reference set atomically through the existing writer;
replacing a client-side snapshot can remove concurrent attachments.

### Working the statement backlog

Recording rows starts a routine Sweep that turns each unmatched charge into
one Transaction suggestion (`suggestions_read.list` with `family:
"statement_transaction"`; `groups: "account_month"` adds per account × month
sections with clean counts); `run.sweep {families: [{family:
"statement_transaction"}]}` reruns it after hand edits to transactions or
accounts, and `run_read.work_snapshot` follows its Steps. Burn the backlog group by group,
filtering a group with `where {account: {in: [FAC-…]}, month: {in: [YYYY-MM]}}`:

1. Accept `clean: true` suggestions in batches of up to 100 with
   `suggestions.review_batch`: verdict `correct`, intent `apply`,
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
   read both. Attach to a different candidate, tick `fields`, override the
   kind, or create anyway (`rejectedCandidateIds` listing every candidate) as
   verdict `wrong` with `correction {present: true, value: <the same
   application>}`.
3. A charge with `siblings` has a same-amount charge from another export: the
   pair may be one charge whose descriptor firmed up. Supersede the thinner row
   (generic `entity.update` on `sourceTransactionRecord`, setting
   `supersededByRowId` to the reviewed successor record ID) before creating
   either. A `claimed` candidate already settles another charge from the same
   source, so it is never clean: attach only when this row is that charge
   re-exported under a new descriptor; two visits for the same amount are two
   creates.
4. A person counterparty is never clean. An outgoing payment to a person is
   your share of a shared cost: create it as `purchase` and set the merchant.
   An incoming one is a repayment: create it, then book it with
   `finance.book_transaction` as `economicRole: "reimbursement"`.
5. A `transfer` names the member's own balance account a cash-out or funding
   descriptor points at (Venmo-style and payout balances are `stored_value`;
   PayPal is read like a card). Review the `transfer_pair` family on the global
   Suggestions page or through `suggestions_read.list`; find pairs with
   `run.sweep {families: [{family: "transfer_pair"}]}`. Accept using verdict
   `correct`, intent `apply`, `expectedFingerprint` and `application {kind:
   "transfer_pair"}`. It creates missing statement-backed legs and accepts the
   pair atomically. The family and statement creates share the
   [opposite-leg clean policy](adr/0016-shared-assessments-and-feedback.md#transfer-pair-suggestions-2026-10-19).
   Cross-owner pairs always need review and record a LedgerTransfer.
   An ATM withdrawal moves money into the `cash` account of the bank
   account's owner (a household checking's cash is the household's), so it is
   an internal move. Cash has no statement: review the proposal to create its
   full-amount leg on the owner's unique cash account, or enter the leg by hand.
   A proposed cash leg is never clean. Record the known ATM fee separately as a
   `fee` on cash; never infer a fee amount. Settle cash spending from that
   account against its Purchase.
   A cash account never reconciles: cash spent and not remembered stays as an
   unexplained balance on purpose. Never invent spending to close it, and never
   settle a Purchase from cash without evidence that the cash paid it.
   Review unresolved overlapping exports before creating a leg; confirmed
   observations must share one FinancialTransaction. Amount and nearby dates
   alone cannot establish charge identity.
6. Dismiss charges that should never become transactions with verdict
   `dismissed` and suppression `{scope: "statement_transaction", candidateKey:
   "<source>:<chargeKey>", fingerprint}`; prefer `disposition: "ignored"` with a
   reason when the whole row must never become a transaction, because that also
   settles every observation. Every real charge is in scope, consumer spend
   included: ignore only duplicates of another export's row, pre-Cubby rows and
   mis-parsed lines, never `not_modeled`.

A refusal (evidence changed, a live candidate, a stale hold, an attach with
several candidates and no named `transactionId`) writes nothing. Labelling
republishes a suggestion under a new assessment id, so a stale-Assessment
error means re-list the group and review the replacement. Explicit pending-to-posted evidence can support a reviewed supersession.
Disappearance requires the complete scope and explicit source confirmation in
[financial-evidence-import](../.agents/skills/financial-evidence-import/SKILL.md#withdrawals).
Age or absence from a later export alone does not authorize voiding a hold.

### Retained review holds and preservation

For temporary review holds, retain prior judgments and a unique marker, keep the
cases visible in the member review, and count them as unresolved. If holding
depends on current booking eligibility, check that eligibility and apply the
hold atomically with the relevant source and transaction locks. Intake copies
judgments into later revisions: reopening must discover original rows and
marked descendants within the proven source identity. Restore only exact
temporary-hold matches and preserve every newer member decision; restoring a
fixed list of old row IDs can leave newer observations held.

Before resuming a retained booking case, read the existing member review and
saved case plans for the exact source, transaction and Purchase identities.
Carry unresolved objections and explicit decisions into the next review brief.
A new preview, approval or successful replay does not itself supersede a prior
hold. Resolve the objection against current evidence and the owning policy
before writing; retain the earlier finding and record why the case can proceed.
Distinguish a reviewer's recommendation from a member's decision. A later
review cannot override an explicit member decision.

Identify intended targets inside protected cohort snapshots before writing.
Preserve every unrelated row and allow only the exact reviewed target effects,
including their specific booking timestamps and allocations. Do not exclude an
entire set or broadly ignore timestamp changes because a target appears there.
Receipt replay and independent preservation read-back establish separate facts.

### Statement review receipts and classification

Statement `suggestions.review` application records a command receipt with operation
ID `command-application:<operationId>` in the `decisions` of the Suggestion identified
by the review handle. Read that Suggestion by the handle, not by `evaluationId`. This
family does not require `acceptanceReceipt` to establish successful application.

Replay the exact committed review request under the same actor and operation ID.
The generic command returns its original applied outcome from the receipt before
reapplying the family or checking current spending fingerprints. Compare the
original Assessment ID, Feedback ID, status and applied result, then independently
verify unchanged source, ledger and attribution graphs. This API does not return
the `replayed: true` flag used by direct `finance.commit_booking`; that writer has
its own replay and current-lineage checks.

Direct booking previews distinguish `candidateCategoryId` (also retained as
`spendingCategoryId`) from `categoryOverride`, the category input persisted on a
newly created Expense, and `effectiveCategory`, the canonical resolution of the
prospective Expense and Purchase. Preserve these fields in the commit request.
A null override stores no Expense category override; bare Purchase creation also
leaves its category null. The Expense's effective category may inherit from its
context or remain Uncategorized, so the preview's candidate label does not prove
the resulting classification. The effective resolution includes its provenance
and a null value means Uncategorized. `existingCategories` shows the canonical
resolutions of the selected Purchase's existing lines; `link_existing` preserves
them. Commit rechecks the live classification policy and projected result.

Optional reviewed `beneficiaries` in direct booking and statement `booking`
uses the existing attribution role format. Omission and an empty reset retain
the normal beneficiary defaults; a null-party share explicitly records unknown
beneficiaries, distinct from Household or a named member. Nonempty shares keep
their exact parties and weights in the review fingerprint and are written by
the Expense attribution owner in the same transaction as booking. A stale or
deleted party refuses the booking. Linking or settling existing spending refuses
creation-only beneficiary choices and preserves every recorded attribution.

Source aggregate creation defaults ordinary purchases to `materials` and fees
to `services`. Optional `booking.costType` in statement review chooses
`materials`, `tools` or `services` for a new aggregate Expense; its draft control
and preview show the choice before application. An absent choice preserves the
existing defaults and retained request fingerprints. An explicit cost type is
refused when linking or settling existing spending; those actions preserve the
existing Expenses. Direct `finance.book_transaction` also accepts `costType`.
Choose it in the original booking rather than editing the resulting Expense.

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
commit, read back the Purchase, Expense, allocation and attribution graph;
check effective category and beneficiary defaults rather than assuming empty
overrides mean uncategorized or Household. Preserve explicit member decisions
about who benefits independently of who funded the payment. Report booked gross
spending separately from unresolved credits.

Historical classification edits remain member decisions. The retained booking
fingerprint hashes full Expense lineage, including names, notes, URLs and joined
attribution/source-claim rows. Even a descriptive edit can therefore require
review during fresh convergence. The old digest retains no original projected
monetary proof against which a narrower comparison could safely run; a projected
current hash cannot be compared to the stored full-row hash. This guard also
protects automatic financial evidence corrections and remains unchanged. Exact
statement command replay still returns its committed receipt. Never reset
fingerprints or undo member edits to force convergence.

Owner ruling for the source cutover: unproven observations stay held with unchanged money and retained advice. Applying held advice returns the held reason. Reviewed identity decisions can use `entity.commands` batches of up to50 independent SourceRecord updates, each with its own expectedDisposition, fingerprint/version/accepted-owner/history checks and explicit judgment. Assign refuses conflicting original account or disposition. Historical reconciliation uses this existing audited batch path; it does not guess identity or require a web action. Publishing a current occurrence review supersedes pending old-key advice for its observations without deleting paid labels or member decisions; dismissing held advice does not suppress a later proven occurrence. Paid labels may be reused across aliases only when their exact model inputs and policy still agree.

Verification uses `entity_read.list` with `entity: sourceOccurrence`, `filters.ids` and `fields: ["closure"]` in groups of at most10 owners. Ordinary get/list reads omit the snapshot; get does not publish this explicit list projection. One snapshot loads shared observation/proof/judgment/membership/alias and accepted/historical money graphs once per page, including retained sibling-alias history. Alias context can name observations outside the selected owners; it never expands accepted ownership or authorizes a write; named sets retain stable storage handles, original relationships and tombstones. Canonical live Expense reads supply effective beneficiaries/funders and category provenance beside recorded weights and overrides. Each named set refuses overflow above1,000 rows rather than returning partial coverage. `scope` names the complete requested owner cohort; the first result alone carries the bounded cohort bundle, whose scope covers every requested owner; remaining results omit closure. TransactionImport notes are omitted. Raw and enriched bundles refuse above one MiB before returning; this bounds serialization as well as row count. Use versions inside the bundle for subsequent review fences. Historical links and receipt references remain read-only evidence. The projection is hidden from ordinary list/detail display and creates no money or work.

Retained PurchasePaymentEvidence stores signed USD `amountMinor` as bigint, including original zero lines; zero does not discard or merge source evidence. Payment-set sums, keys and direct amount comparisons use minor units. Existing purchase-import and spending boundaries retain dollar-number `amount`, including the frozen reconciliation fingerprint shape. Source extracts and successful receipts are not rewritten. The narrow migration retains the original table in archive and proves independent IEEE amount equality plus equality of every other field. Ownership, relationships and Expense costs stay unchanged. Other legacy money fields remain pending separate conversions; three noisy Expense values require original decimal evidence or a member judgment.

Identity-only collection references and retained retries read physical observations with explicit owner keys. Automatic eligibility hashes the complete unresolved-owner fence once, without loading every historical transaction code per suggestion. New source consumers require a timed plan, including background and record-scoped review reads.

Purchase paperwork totals store nullable signed bigint `statedTotalMinor`. Native and existing entity wires retain dollar-number `statedTotal`; server reconciliation compares exact minor units. The preserving cutover archives complete original Purchase rows and refuses any original that cannot independently round-trip through cents, including IEEE noise. Booking fingerprints retain their original dollar shape. Expense costs remain unchanged while their three noisy originals lack exact source proof.
FinancialTransactionAllocation stores signed nonzero bigint `amountMinor`; allocation inputs, native/entity reads, retained fingerprints and audit receipts stay in dollar numbers. Allocation-set conservation and merging use exact minor units. The preserving migration keeps every original allocation edge, confirmation and tombstone in archive and refuses unproven cent values. Expense cost conversion remains blocked by three noisy originals.

Raw SQL dollar fields entering retained JavaScript fingerprints must use the PostgreSQL float8 driver boundary or an explicit decoder. An `execute<T>` annotation does not decode numeric strings. Retained float-sum fingerprints preserve their original per-row float8 accumulation; authoritative conservation and writes use minor units. SQL-hashed JSON/text boundaries also require the original float8 representation rather than numeric scale.

FinancialTransaction amounts are stored as signed exact minor units. Native, MCP and audit receipts keep dollar numbers. Raw PostgreSQL reads that enter retained spending snapshots decode to float8 dollars, including embedded transaction JSON; TypeScript `execute<T>` does not decode PostgreSQL numeric strings. Exact storage arithmetic and preservation guards do not depend on these compatibility projections.
