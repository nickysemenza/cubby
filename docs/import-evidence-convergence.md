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
batches read-only candidate facts; it never supplies cached evidence to a
booking commit. Ready plans and commit-time validation retain the complete
graph and current ownership checks.
Matched transactions with live allocations create no new statement booking
work; an existing pending booking is revisited so completion can retire it.
Expense edits use generic field Suggestions, and allocation reconciliation uses
explicit finance commands. Transactions without statement observations can
invoke the shared commands directly; statement discovery uses retained rows.

Clean new spending requires one high-confidence live Cubby spending category
without conflicting merchant history, plus the existing transaction-kind
agreement checks. Category history is optional and there is no amount cap.
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
amount/date coincidence never proves identity. Refunds require supported
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
tracked packages across lifecycle Emails reuse the established Purchase,
resolved carrier and tracking reference. Extraction leaves
`distinctPackageEvidence` null for these updates; only explicit evidence of a
separate package bypasses that matching. A new Email, item list or status change
alone does not establish a separate package. Trackingless packages still need
a stable source package key and distinct-package evidence. Identical
unkeyed source rows retain their multiplicity; replay updates the same
occurrences. Native event keys scope changed versions to their source package.
A later A → B → A report retains a third version, while stale captures cannot
replace a newer current version. Every supporting capture retains membership
with its observations, including unchanged events in changed page snapshots.
Page content is retained and hashed without trimming. Email captures retain
their original content alongside the verified Email reference and checksum.
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

SpendingCategory is independent of ProductCategory. Purchase defaults flow to
Expense lines unless a line has its own category. Itemization expectation resolves
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

## Financial evidence entities

[Terminology](guide/terminology.md#naming-policy) owns the names; the
[README overview](../README.md#financial-evidence) owns the entity map.
Both entities use generated list and detail routes in the Financial evidence
area: `/source-transaction-records` and `/transaction-imports`.

Source transaction records enter through `finance.record`.
New observations require an attested provider transaction ID in its account
scope or a stable physical collection position. Equal dates, descriptions and
amounts never establish occurrence identity. Unpositioned requests can only
replay a uniquely retained historical collection member; they cannot add new
observations. Existing historical identities, decisions and settlement references
remain unchanged. Supply positions for every occurrence in new ID-less exports,
including identical transactions across chunks.
Generic create and merge are unavailable. Provider facts, identity, revisions,
collection membership and source coverage remain intake-owned and immutable
through generic commands. Generic updates edit only declared household judgment
fields: account resolution, disposition and its explanation, supersession and
notes. A successor is an explicit reviewed record relationship, not a match
inferred from similar descriptions or amounts. These commands use the shared
audit path. Import membership audits record the newly received record IDs for each chunk; public audit reads resolve the declared record relationship to shortcodes,
without copying the collection’s growing membership into every audit entry.
Prefer an explained ignore judgment when evidence should remain
retained but leave reconciliation worklists.

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

Keep every source observation and original description. Provider identity is
scoped to its source and account; immutable revisions retain one explicit
charge key. Provider status is optional metadata. ID-less file occurrences
retain physical positions, including distinct identical rows and zero-value
records. Separate ID-less observations remain independent across collections;
content equality alone cannot establish that they are one charge. Zero evidence cannot create spending. Historical reference strings
remain accepted links, with one explicit charge owning a legacy alias; the
alias alone never spreads an ignore or settlement to coexisting charges.
Cross-provider equality proposes reconciliation rather than establishing identity.

Replaying a retained collection with newly supplied provider IDs cannot silently
replace its ID-less charge identities. Intake refuses a provider identity that
overlaps an ID-less member at the same physical position, or an unpositioned
member's frozen reference. Exact existing provider observations can replay through
the usual immutable-evidence checks, preserving frozen provider-bearing `v2`
identities and charge keys within their original collection. A deleted or
ambiguous retained provider member remains held; changed evidence requires a
new collection rather than rewriting the retained observation.
Resolve a new source identity explicitly before replay;
this guard neither rewrites historical observations nor assigns identifiers from
content equality. Distinct positioned occurrences remain independent, including
identical rows delivered in later chunks.

When checking independent evidence for an amount correction or confirmed
withdrawal, a superseded charge no longer corroborates the older booking.
Unresolved references and genuinely independent current charges still require
review; supersession does not grant authority to change money by itself.

Retained provider identities that span multiple compatible charge keys remain
review-required in statement discovery, fresh preview and financial application.
The guard uses provider/source scope, complete known account-ID history and
explicit live account aliases; it checks legacy null account scopes as well as
known scopes. Distinct known provider account IDs and genuinely positioned
ID-less occurrences stay independent. Equal amounts or merchant text grant no
identity authority. Supersession, ignore, withdrawal and deleted observations do
not prove event equivalence or release the successor's unresolved identity.
Discovery and refusal preserve observations, keys, memberships, references and
member judgments; identity resolution remains separate review work.

The bounded charge page loads provider history and account facts before spending
preparation. Its evidence fingerprint includes relevant retained scope and
mutable alias facts, and publication rechecks those facts after model work.
Application rebuilds them inside the existing snapshot write, including for old
clean Assessments. A collision or scope change after preview refuses application
without money or an application receipt while preserving the durable member
command. Exact successful canonical receipt replay precedes the live guard and
remains inert. Model labels and paid advice cannot release this evidence hold. A
statement action that applies a transfer pair binds both source legs' provider
identity facts to its preview/publication fingerprint. A collision on the
opposite leg, including compatible deleted history excluded from transfer
discovery, holds either statement proposal. Publication and application batch
that complete source set again, and the transfer writer independently refuses
unresolved source-leg identity inside its transaction before creating either leg.

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
and an explicit recheck. The retained current head records its withdrawal and
proof collection. Old observations cannot reactivate it; only newer positive
evidence can. A later-dated export alone never proves disappearance.

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
funding date stays unchanged.

Suggestions remain one per actionable charge. Matching a source observation is
separate from booking Expenses. Existing candidates must be rejected before a
new transaction can be created. Historical collection membership may include surplus or mispositioned evidence.
It cannot by itself dismiss an existing settlement candidate during Suggestions
discovery; ambiguous identity remains review work before new spending. Descriptor/amount/date coincidence is advisory;
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
Unscoped label passes may complete consecutive no-action receipts
in bounded transactions: lock the exact receipts, verify their charge/evidence,
active pending state and absent rule descriptors, then clear only the proven
prefix through the projection writer. A missing, replaced or rule-bearing receipt
stops the batch even when its rule is paused. Release the locks before ordinary
application and reread the suffix after it. Import-scoped passes retain regeneration
before each admission, since regeneration can introduce actionable rules.
Interruption preserves reusable labels and completed publications.
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
planner as acceptance. It writes no aliases or records. The preview identifies
transaction changes, vendor reuse/creation and alias effects, Purchase/Expense
and settlement effects, purchaser basis and the explicit vendor-account state.
Changing a draft refreshes the result; acceptance still replans inside its write
boundary. Kind controls apply only to a Create draft; an attachment first uses
Preview new transaction to review that alternative. Provider category is evidence,
not a Cubby spending-category assignment:
retain each provider/category observation, joining other provider charges only
through authoritative settlement references to the same transaction.
