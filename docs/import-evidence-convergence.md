# Purchase, photo, and statement evidence

Bank transactions are evidence; Expenses are the spending ledger. Statement
imports and re-imports discover booking work for every observed charge,
including unchanged observations already matched to an unbooked transaction.
Clean posted purchases and fees book spending automatically; uncertain work
remains in the shared Suggestions queue. Pending holds book no Expenses until
posted. Transfers, card payments and ordinary income remain settlement-only.
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
unique conserved set. Retained settlement matches posted charges only; a
pending authorization remains unallocated until posted. Weaker same-Vendor candidates within fourteen days,
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

CSV identity preserves each physical nonzero occurrence, including identical
rows; zero-valued placeholder rows are counted, not saved. Stable provider identifiers are retained; historical
identity aliases remain recognized. A date/amount/status change is a reviewed
candidate attachment, not an automatic merge. Ambiguous same-amount transactions
remain separate candidates. Source rows and their original dates stay intact.

Export coverage records every retained statement identity observed in that
export, independently of which export first inserted its row. Replaying an
overlapping export adds membership evidence without moving original rows,
changing provider values, or creating transactions. Partial exports remain
incomplete; a dry run records no membership. Historical migration seeds only
known first-ingesting memberships; other exports require original-source replay.
Original first ownership remains membership proof through the deployment
window. Drift excludes row pairs known to coexist in any export, even when
another export first retained one. Retired import bookkeeping retains that
coexistence evidence; live coverage still excludes deleted statement rows.
Legacy identities cannot establish distinct
physical occurrences by themselves.

A provider charge is every observation sharing one v1 identity: repeated
exports record new occurrence rows for the same money. An ignore, supersession
or live settlement ref on any observation settles the whole charge, so match
state and unmatched counts are per charge. Statement Transaction suggestions
propose, one per unmatched charge, creating a transaction, attaching to an
existing one (same account, same cents, within three days, whatever the
descriptor), superseding a recorded hold with its posted row (posted at or up
to the larger of 25% or $20 above the hold, within seven days), or voiding a
vanished hold. Enabled clean import booking applies current clean spending
plans as described above. Other work waits for review except through the
`statement_transaction.attach` Automatic rule ([ADR 0016
amendment](adr/0016-shared-assessments-and-feedback.md#amendment-sweeps-the-suggestions-page-and-automatic-rules-2026-10)):
once a member turns it on, an attach to the sole candidate, with no possible
twin, at the same cents and labelled the same charge with high confidence by a
decision model whose own reviewed matches are eligible, applies without review
outside its audit sample, and never copies statement fields onto the
transaction. A create is refused while any candidate the member has not
rejected remains. A same-amount charge from another export is a possible
firmed-up twin and is never bulk-acceptable. Decision-model labels rank
candidates and choose a fallback kind; on their own they never authorize an
attach or suppress a create.

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

The vanished-hold void is the one
bounded absence judgment: it applies only to a transaction recorded from rows
the provider itself marked pending, with no posted twin, after a later export
of that account covers dates seven days past the hold without containing it,
and it voids rather than deletes, keeping the refs. Absence never proves a
posted charge did not happen.

Provider account masks retain all supplied digits, including non-card masks
longer than four digits. An account name already containing that mask does not
receive a second suffix. These descriptors participate in statement identity;
normalization must not truncate them into a different account reference.
Rows recorded before complete masks carry a `(...last4)` suffix, unless the
account name already contained those four digits (`Card 4821`), in which case
the name was stored with no suffix. A positioned replay of a suffixed
occurrence whose complete mask ends in those four digits upgrades the stored
descriptor in place and reports it in `maskUpgrades`; its charge key keeps the
original hash. A different trailing mask, an unpositioned row, or a suffixless
pre-change name still raises the immutable-evidence conflict on replay.

Retailer preparation can explicitly target an orderless Purchase. Receipt
itemization proposes a replacement finding with original lines, proposed
identities, and exact beneficiary/funder amounts. Approval binds the full
proposal and original graph; changed proposals or edited originals fail.
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
two seeded arrival orders of Gmail, retailer, photo, and CSV evidence against
PostgreSQL through
the same writers the routes dispatch: real normalization, persistence,
retailer preparation/commit, photo staging/finalization/review, CSV intake,
booking, finding resolution, and order-mail linking.
`import-order-convergence.spec.ts` retains two browser orders: statement-first
requires reviewed receipt reconciliation; receipt-first links existing
itemization. Both retain signed photo upload, photo review approval, CSV browser
intake, and vendor-to-Purchase-to-Product navigation. The statement-first case
also retains the Problems fix beyond the overview's first twelve findings.
The PostgreSQL matrix owns sampled source-ordering coverage. Only external
classifier/image-description output is deterministic. Both assert the final Product, inventory ownership, Expense,
Purchase allocation, and original source edges; neither seeds the economic
graph or repair it at the end.

`pnpm test:e2e:sim -- --headless --statement-csv` drives a real Swift CLI
file through shared OpenAPI preview and reviewed commit. It checks read-only
preview, repeated physical rows, exact replay, changed-byte refusal, ambiguous
settlement-date attachment, and no implicit Expense or Inventory writes. The
CLI is a loopback test harness; native UI acceptance still exercises file
selection, presentation, and approval.

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
native intake, capture, photo approval, or CSV save. Locked-host or authentication failures must remain failed milestones.
Live Gmail authorization, live retailer changes, and physical iPhone photo
quality remain distinct from deterministic import convergence.

## Migration and rollout

Follow [production change rules](agents/domain-rules.md#production-changes).
Historical backfills must preserve unknown acquisition origin and evidence;
existing bank transactions and Expenses are not automatically reclassified or
booked. Deployment never applies migrations.

## Reviewing statement outcomes

Suggestions is the reconciliation workspace: Pending proposals, optional Automatic
decisions audit, and Automatic rules. Statement Rows is the imported-evidence
browser and defaults to all observations; its scoped review links preserve the
account, amount and date. Several rows can describe the same charge.

Statement review shows Source, Proposed result and Evidence. The read-only
`statementRow.previewSuggestion` revalidates the Assessment fingerprint and live
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
