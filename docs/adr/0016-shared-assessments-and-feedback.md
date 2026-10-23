# ADR 0016: Shared Assessments and Feedback

Status: Accepted design; implementation and migration are under review.

Field Suggestions, Email review and accuracy grading, image-description
corrections, Product matches and generic recommendation Dismissals capture
parts of the same review loop through separate contracts. Consolidate them in
one refactor PR, migrating existing history, updating every client and removing
replaced paths. Shared infrastructure owns reproducible Assessments and
Feedback; typed domain handlers retain actual field updates, Email corrections
and Product merges. Model execution/usage logs and the durable execution engine
retain their existing owners. Canonical language lives in
[terminology](../guide/terminology.md).

## Review and migration

An Assessment records the judgment, typed subject (record, field or pair),
producer/model and revision, relevant evidence snapshot and fingerprint.
Feedback records a member's verdict, optional corrected value, reason and
supporting evidence, separately from independent AI grades and automatic
application. Wrong, uncertain and presentation-only Dismissal are distinct.
Optional reasons must not obstruct reviewing a wrong result.

Carry legacy outcomes, corrections, evidence and suppression behavior forward
as recorded. Explicit corrected values or reviewed verdicts can supply labels;
ambiguous historical rejection or dismissal remains ungraded. Preserve confirmed
image descriptions and member Email decisions across future automatic work.
One review does not automatically rewrite a heuristic or prompt: false positives
feed reproducible evaluation cases and tested engineering changes.

Feedback remains bound to its original evidence even when records change.
Domain mutations separately revalidate current fingerprints and authority;
material changes retain historical Feedback but require a fresh comparison
before applying a correction or merge. Reuse existing atomic receipts and
execution coordination rather than introducing another scheduler.

## Product identity

Detection covers all live Products, including older records and every creation
path. Database identifier/name/model checks and embeddings retrieve candidates;
calibrated Jev/Clef decisions evaluate shortlists. Frontier investigation is
member-requested. Strong actionable pairs with concrete supporting evidence
become Problems; weaker pairs remain recommendations. Similarity and model
verdicts alone cannot establish a variant or authorize a merge. Unknown variant
facts remain unknown.

Run detection in the background after relevant identity or photo changes and
through an initial catalog pass, respecting Automatic work settings. Problems
reads stored results without launching model calls. Store pairwise evidence and
present related pairs as one grouped Problem: A/B and B/C do not establish A/C
or authorize a group merge.

An exact identifier conflicting with verified variant facts produces an
identity-conflict Problem, without recommending a merge before the contradictory
facts are corrected. Confirmed variant differences outweigh embedding and AI
similarity. Product identity merges preserve stock and show combined quantities;
stock on both records can represent legitimate copies. Duplicate receiving is a
separate explicitly reviewed inventory correction.

## Implementation boundaries

Assessment predictions and Feedback events are immutable.
The shared application repository enforces append-only history; database
immutability triggers are unnecessary for the trusted household's writers.
Current actionable state, confirmed corrections and suppression are separate rebuildable
projections. Original subjects refer to durable Entity identity and retained
snapshots; merges or deletes retire or repoint current targets without rewriting
historical subjects. Image deletion removes live description authority while
preserving its review history. Runs and model usage are historical references,
not cascading owners of review history.

Typed subjects include record fields, canonical Product pairs, and Email order
events with their original/checksum and Purchase target. Field draft acceptance
is distinct from saved application. Current producer outputs carry retry-safe
publication identity and evidence fingerprints. Legacy origins explicitly allow
unknown producer/evidence and standalone confirmations without fabricating a
predecessor prediction. Corrected JSON null is distinct from absent correction.

Suppression retains its original declared scope and candidate key. Recommendation
subjects may name any shortcode entity, including a Run with a group/photo scope
and candidate Product key. Explicit history-only Wrong Feedback can suppress that
declared candidate, just as Dismissal can; a bare Wrong verdict remains a grade.
The [photo identity journey](../guide/product-identity-journey.md#photo-inventory-review)
owns photo-group lineage and client behavior. Legacy field
value rejection, Product-pair suppression, group-key recommendation suppression
and related/tag preferences do not become universal negative labels. Preserve
old application receipts and distinguish automatic application from explicit
member review. Paired unserved model trials remain outside the review queue.

Email frozen evaluation rosters retain sampling strata, inclusion probabilities,
predictions and coverage. Evaluation-only grades remain independent of member
routing authority. Migrate any existing authoritative labels with their actual
semantics rather than treating all historical grades as routing instructions.
Email event selection, one linked Purchase per event, accepted-source protection,
member ownership, checksum fences and lock order remain domain invariants.

Confirmed image descriptions remain authoritative in display, classification and
search, including when no generated analysis exists. Retain inactive corrections
and confirmation times without inventing historical file hashes. Changes refresh
all affected search/embedding projections.

The shared review operation records historical Feedback independently of apply
intent. Applying uses typed domain preparation followed by transaction-bound
current-evidence and authority checks, domain writes, review publication and
existing application receipts. External retrieval or model work occurs before
that transaction. Batch items settle independently. Product merge and survivor
image ordering commit together.

Extend the existing durable evaluation target and refresh policy for Product
identity work. Initial coverage is cursor-based and resumable across all live
Products; it does not rely on the newest photo-only seeds. Exact identifiers
retrieve candidates independently of name/model gates. Verified variant facts
carry evidence rather than being inferred from a title. Reads query stored
assessments and current projections without discovery/model calls.

## Scoped review reads

Suggestions lists/counts and record-scoped Automatic Decisions intersect the same
family-declared references. Admission uses a typed scope (families, status, Run)
rather than caller-supplied SQL aliases. Primary-reference hits skip JSON graph
construction; secondary references retain the declared family expansion, including
UUID and shortcode matching. For record-scoped automatic history, materialize the
matched identities before checking application and member Feedback. Broad entity
scopes use one join so the identity barrier does not duplicate full-table work.
The existing family/active/status and Feedback assessment indexes serve both paths.

## Cutover preservation

One owner controls the production cutover. An early expansion/copy is not the
preservation boundary: old writers can still overwrite copied rows. Quiesce
relevant writers, drain or transform existing persisted work and close old
in-flight requests; reconcile under source-table locks before removing their
storage. Keep writes fenced until the matching server is deployed, retired
references and constraints are removed, and current clients reconnect/update.
Use explicit migration journal boundaries from the owning runbook, not an
unbounded migrate command. A lock or observed idleness alone is not a barrier
across deployment.

A populated predecessor test and private production preservation report compare
source-origin coverage, retained outcomes, receipts, confirmed corrections,
frozen sampling metadata and exact suppression keys. Validate an intervening
legacy update and refusal of stale application. Transform persisted evaluation
and Run payload references to retired shapes, and verify new incoming-edge
policies before retiring FKs. No household data is reset or discarded.

## Storage and caller contract

Declaration-owned Assessment and Feedback history is separate from a shared
AssessmentState projection. Assessment subjects and predictions never change;
AssessmentState owns current targets, pending/resolved/superseded state,
confirmed values and explicitly scoped suppression. Its physical entity,
recordId, field, family and state columns preserve indexed discovery. The shared
transition writer locks current rows in ID order and records one exact changed
column patch per row as projection Feedback. It batches heterogeneous updates by
written column set through native, keyed updates; omitted columns stay unchanged,
JSON null suggestions remain JSON, and returned rows retain column decoding.
Events, updates and commit-only invalidation remain in the caller's transaction;
rebuilding does not depend on batch boundaries. Native update hooks run once per
statement, so rows in a batch may share an update timestamp.
Pending field reads compare captured authoritative field, basis and reference
snapshots and the latest explicit field-write intent. Applying locks those
inputs through commit and repeats the specific fingerprint check; unrelated
table-wide revision changes do not invalidate advice. History remains available
when current advice becomes stale. Schema changes include the derived-DDL
migration, not only the table migration.

Field producers call `publishFieldAssessment`, which delegates to the shared
transactional `publishAssessment` writer for immutable evidence and its current
projection. The producer supplies serving explicitly; paired trials do not gain
member authority by inheriting a Run's model pin. Projection inserts do not
synthesize history through a trigger; the history foreign key rejects a writer
that omits publication. The cutover drops only the old trigger and function,
preserving existing evidence and projection handles.

A typed family registry owns subject and judgment schemas, fingerprints,
authority checks, supported review actions and projection invalidation.
Typed connection recommendations use the existing recommendation family with
relation-specific scopes and retained evidence. Their acceptance routes through
the shared review operation to a typed domain action; unrelated recommendation
scopes remain history-only. Existing field, Product-pair and Email-link
Assessments retain their original handles and authority. A connection can be
read from either endpoint without creating a second judgment or review ledger.
Record-scoped reads restrict reference kinds before expanding related graphs.
Email outcomes traverse linked Purchases only for Purchase scopes; field
reference expansion selects only the requested target kinds. Mixed scopes keep
every requested endpoint, while presentation still enumerates all references.
Reference expansion is projected inside the materialized eligibility relation.
Consumers match those references directly; rejoining the base tables can let the
planner expand unrelated history before intersecting eligible identities.
The [connection journey](../guide/entity-connections.md) owns its behavior.
The shared public review operation supports historical review without applying,
or review plus a prepared domain action. Saved-field inference mints Assessment
references before review; draft acceptance is review history, and saved
application gains its own receipt. All clients consume these references and
shared actions. Business operations such as import resolution remain domain
operations, but record their review through the shared infrastructure.

Existing immutable retrieval/model observations may remain source evidence,
referenced by Assessments without copying full originals. Frozen evaluation
rosters remain evaluation metadata; grade/review events move to Feedback.
Sampling, replay and weighting semantics survive independently of operational
member authority. No parallel feature-specific review or dismissal ledger
remains. Model usage and execution ledgers are not review ledgers.

Opaque legacy recommendation keys retain exact family/kind/group scope and
suppression, without claiming pairwise distinctness. Legacy origin table and
row identities remain in retained metadata. Unknown historical model versions,
byte fingerprints, corrected values and actor intent stay unknown. A present
corrected null has an explicit presence discriminator.

Product work uses the existing AI-refresh activation as its automatic gate;
image automatic-processing preference remains independent. Product evaluation
and catalog sweep use existing durable work with canonical pair evidence share
keys, retries, cursor coverage and publication fences. Preserve served-model
trial semantics. Explicit miscellaneous placeholders can be ineligible but
count toward declared catalog coverage rather than silently disappearing.

Deletion or merge updates current-state edges and removes self-pair actions,
not historical subject snapshots. Confirmed-value projections disappear with
their live target. Durable Entity identity supports historical references;
Runs are nullable provenance references rather than cascading history owners.

No fixed embedding score is proof. Calibrate decision admission against known
duplicates and distinct variants; rule-backed evidence can surface a Problem
without AI availability, while embedding-only pairs remain recommendations.
A failed evaluation stays retryable and cannot erase a previously valid result
or claim catalog coverage completed.

Registered external identifiers have one live owner for each source/kind/value.
A two-owner JOIN is therefore not the useful duplicate evidence path. Detection
can use retained exact-variant claims only when original evidence and real
Product bindings establish both claims. A prepared candidate or a number in
free text does not establish ownership. Matching source URLs and nonempty
free-form selected-variant strings retrieve candidates; they do not alone prove
complete variant identity. Shared model/style numbers remain ranking evidence.
Confirmed contradictory variants under a retained exact-variant claim surface
an identity conflict before any merge recommendation.

Product-pair publication identity is canonical subject plus relevant evidence
and decision-policy revision, not occurrence Run, evaluation or request IDs.
Repeated or opposite-order scans under unchanged evidence/policy retain the
first published producer and resolved review state. Relevant evidence or policy
changes can publish a fresh Assessment while historical Feedback remains bound
to the original. Review retry identity separately preserves the application
receipt and refuses conflicting reuse rather than repeating a domain mutation.

## Amendment: statement Transaction suggestions (2026-10)

The `statement_transaction` family targets a non-shortcode record, the
canonical SourceTransactionRecord observation of one provider charge, as `email_link`
targets a retained mail event. Its judgment is proposal-shaped: one
Assessment per charge carries the recommended action, every attach candidate
and the create payload, because rejecting the candidates is what makes a
create available. Accepting the recommendation is Correct Feedback; choosing
another action is Wrong Feedback whose correction is the chosen application.
Dismissal suppresses the charge's declared `source:chargeKey` key. Decision
labels republish the same evidence fingerprint under a model producer; apply
recomputes that evidence fingerprint inside the review transaction and marks
the state applied before writing refs, because a new live ref supersedes
every pending suggestion naming it.

A create's kind is clean only by agreement (2026-10-18). Three sources vote:
the provider-category rule (overridden by a descriptor naming the member's own
balance account, which makes the charge an `account_transfer`), a
high-confidence decision label that sees the category only as a hint, and
merchant history — at least two earlier live transactions on the account with
the same normalized merchant, all of one kind. History counts only
transactions a member created or chose: one created by accepting a clean
create as is records the rule's own vote, read from its applied Assessment
and Correct Feedback, and is excluded. Mixed history disagrees. The judgment
records every vote; a kind is clean when at least two name it and none names
another, the label says the counterparty is a business, and neither the label
nor history says a person. On a stored-value account (a payment app) history, not the label,
must say business: its payees are mostly people whose notes read like
merchants. A person counterparty is never clean: an outflow is the member's share
of a shared cost (`purchase`), an inflow a repayment (`income`, booked as a
reimbursement). A transfer or card payment is clean only once its opposite
leg is matched (an equal amount of the opposite sign on another account within
a few days); until then votes and a descriptor naming an own account cannot
tell an internal move from money leaving to another owner. A move between
different owners also owes a LedgerTransfer and is never clean.

### Transfer-pair Suggestions (2026-10-19)

The `transfer_pair` family discovers unmatched money movements across accounts:
transfer/card-payment statement charges and eligible FinancialTransactions with
no LedgerTransfer. Candidates have equal amounts, opposite signs, different
accounts and dates within five days. Evidence shows both legs, their accounts
and owners, the date gap and every competitor, including weaker descriptor
matches. Pair identity follows the charge, not its export observation.

Kinds and provider categories retrieve candidates; they do not establish
movement-shaped descriptors. A declared Decision labels each descriptor as an
account move, a payment or insufficient evidence. Both high-confidence account
move labels are necessary for clean acceptance, alongside the independent
structural checks below. Generation publishes weak pairs first, then the label
pass republishes them. Labels survive a later rule pass only while the base
evidence fingerprint is unchanged. A label publication refreshes the statement
projections for its legs, including when only Transfer pairs was swept.
Dismissal suppresses that pair key on later Sweeps.

A pair is clean only when both legs have exactly one candidate, their date gap
is at most three days, both accounts have the same known owner, and both legs
carry explicit movement evidence (transfer, card payment, cash-out/funding or
ATM withdrawal). Generic payment/deposit, ACH, checks and repayments require
review unless stronger context identifies an account move. Model confidence
never supplies apply authority. Different owners always require member review.

Confirmed observations from overlapping exports converge on one
FinancialTransaction per leg. Same account, amount and nearby dates flag
possible overlap but do not prove identity: unresolved overlap prevents clean
acceptance and creating duplicate legs. Review the observations through the
statement reconciliation path before pairing them.

Member apply creates missing statement-backed transactions with their source
refs and assigned statement accounts, then calls `finance.accept_transfer_pair` atomically. A same-owner pair
records an internal move; a cross-owner pair records money between those owners.
Apply rechecks current evidence, eligibility, ownership and competing candidates;
retries cannot pair a charge twice. Bulk Accept uses the same path for clean
pairs. In a mixed-family batch, overlapping statement and pair suggestions
settled by an earlier pair return `settled_by_pair`, without another apply or
Feedback event. Statement transfer/card-payment creates use this same opposite-leg clean
test and pair writer, replacing the blanket unclean stopgap from #2823. A found
statement row qualifies even before its FinancialTransaction exists. Everyday
spend booking remains the separate #2738 path.

Cash is a valid destination without a statement. An ATM withdrawal with no
recorded cash leg may propose creating the full-amount leg on the owner's unique
cash account, but this proposal is review-only: an invented leg is not found
opposite-leg evidence. The bank amount includes the ATM fee; record that fee
separately on cash, with its supplied amount, and never infer it.

## Amendment: Sweeps, the Suggestions page and Automatic rules (2026-10)

Every actionable proposal family reports to one Suggestions page; discovery
families report to one Sweep. Automatic decisions have a separate audit view,
as described in [the entity review contract](../entities.md#shared-proposal-queue-and-automatic-decisions).
Stored pending status alone does not imply a proposal. A
member's Sweep is one Run whose declared RunSteps cover each chosen family;
steps that need the model fan out to per-item AI evaluation Jobs and wait on
them, with no child Runs. Automatic passes are routine Sweeps. Family
registry entries still own candidate matching, stale-evidence rechecks, apply
authority and identity or financial safeguards.
The shared layer adds listing, Strength, Impact, the clean flag and bulk
actions. Families may supply a narrow pending-count projection for scopes
without column filters, using the same eligibility and scope as list keys.
Column-filtered counts retain the shared key filters; reviewed outcome counts
retain their independent family, entity and Run scope. Statement counts group
only clean and first-candidate label facts, then reuse the family's Strength
classification. They materialize those facts once before aggregation and omit
automatic-rule applications exactly as the pending list does.
It never adds a generic confirmation: connections keep their
per-integration review paths and stay individually reviewed.

An Automatic rule is the only way a Suggestion applies without review. It is a
named, versioned family declaration matched by deterministic evidence; model
confidence can be part of a rule's definition but never authorizes one alone.
A rule becomes eligible only after member-reviewed matches show at least 98%
precision across at least 50 items in a rolling window of the latest 200. A
member then turns it on. While on, a 5% audit sample of matches stays pending,
and the rule turns itself off when audited precision falls below the bar.
Every automatic application records `automatic` Feedback that names the rule
and revision, and stays listed in Review automatic decisions. Wrong on an automatic
application records a Miss and opens the normal correction; it is not an undo,
since the household has no restore or undo. The [field assignment and refresh
contract](../entities.md) owns assignment eligibility and rediscovery.
Statement attach becomes a rule that starts off, which amends the advisory-only
sole-candidate rule in `docs/import-evidence-convergence.md` for that one rule.

The [convergence contract](../import-evidence-convergence.md) owns statement
import-clean execution, its financial evidence and booking requirements. That
explicit import policy also uses shared review and automatic receipts.

The alternatives were keeping every apply reviewed, which leaves the
statement backlog manual indefinitely, and confidence thresholds per family,
which let a model's self-report authorize writes. Measured precision on the
household's own reviews, a member-owned switch and a standing audit sample keep
authority with the household while it scales.
