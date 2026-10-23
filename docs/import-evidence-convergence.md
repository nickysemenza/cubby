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
order identifier or printed total. New bare Purchases use the account's live
member owner as purchaser; household-only or missing purchaser evidence needs
review. Funding attribution remains its own dated contract.

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
Each application still uses `entity.review_assessment(s)` and records automatic
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

Mail preparation validates source kind, owned original identity and exact
checksums before any paid attribution or relationship judgment. Admission
decisions cannot repair altered bytes; the writer repeats those checks and
requires roster membership inside its transaction.

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
discounts never need one). A lone productless goods line is a lump. Totals stay
with paperwork and settlement reconciliation. Itemization, Product resolution,
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

Source transaction records enter through `source_transaction_records.record`.
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

## Normalized financial evidence intake

Claude/Codex use the [financial-evidence-import skill](../.agents/skills/financial-evidence-import/SKILL.md)
to read Monarch MCP or parse Monarch, Mint, Copilot and Apple Card exports
locally. Cubby accepts normalized observations through `source_transaction_records.record`;
the application has no financial CSV parser, upload, mapping, preview/commit,
native file picker or CSV CLI. USDA parsing and expense report exports are
independent of financial intake.

Keep every source observation and original description. Provider identity is
scoped to its source and account; immutable revisions retain one explicit
charge key. Provider status is optional metadata. ID-less file occurrences
retain physical positions, including distinct identical rows and zero-value
records. Separate ID-less observations remain independent across collections;
content equality alone cannot establish that they are one charge. Zero evidence cannot create spending. Historical reference strings
remain accepted links, with one explicit charge owning a legacy alias; the
alias alone never spreads an ignore or settlement to coexisting charges.
Cross-provider equality proposes reconciliation rather than establishing identity.

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
or settled charges remain excluded. Generation and label pages commit per
charge, so interruption preserves reusable labels and completed publications.
Acceptance always validates the current broader evidence fingerprint.

Within one read-only proposal page, spending preparation loads shared account
and transaction metadata, settlement references and allocations once and prepares at most four independent charges
concurrently. The metadata is discarded after that build; label work and
financial application rebuild current facts. Purchase-payment candidates are
selected once for the page's admitted amounts and date envelope. Vendor
Purchase pools, booking graphs, payment rows and category history are shared
only inside that page; per-charge date, amount, refund and explicit-target rules
still select candidates. Requests outside the admitted bounds use the original
fresh SQL selector. Publication retains its own
four-transaction limit and per-charge locks, suppression checks and settlement
rechecks. Generation logs separate selection, preparation, publication and
import-application durations with aggregate counts, without source records.
Generation checkpoints depend only on model-free generation and publication;
optional model preparation cannot delay them. The later label step retains
ownership of model decisions and reuses compatible durable label checkpoints.
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
allocations. `mail.resolve` can link a lifecycle Email to several existing
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
`import-order-convergence.spec.ts` retains two browser orders: statement-first
requires reviewed receipt reconciliation; receipt-first links existing
itemization. Both retain signed photo upload, photo review approval, normalized evidence recording, and vendor-to-Purchase-to-Product navigation. The statement-first case
also retains the Problems fix beyond the overview's first twelve findings.
The PostgreSQL matrix owns sampled source-ordering coverage. Only external
classifier/image-description output is deterministic. Both assert the final Product, inventory ownership, Expense,
Purchase allocation, and original source edges; neither seeds the economic
graph or repair it at the end.

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

Suggestions is the reconciliation workspace: Pending proposals, optional Automatic
decisions audit, and Automatic rules. Source transaction records is the generic
imported-evidence browser; Transaction imports shows the retained collections.
Filter the declared evidence projection by account, amount, date and match state
as needed. Several observations can describe the same charge.

Statement review shows Source, Proposed result and Evidence. The read-only
`sourceTransactionRecord.previewSuggestion` revalidates the Assessment fingerprint and live
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
