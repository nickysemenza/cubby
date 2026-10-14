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

Assessment predictions and Feedback events are immutable. Current actionable
state, confirmed corrections and suppression are separate rebuildable
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

Suppression retains its original declared scope and candidate key. Legacy field
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
recordId, field, family and state columns preserve indexed discovery and
trigger-driven field supersession. Update both generated Postgres triggers and
kernel invalidation to the new state path, including input dependencies. Schema
changes include the derived-DDL migration, not only the table migration.

A typed family registry owns subject and judgment schemas, fingerprints,
authority checks, supported review actions and projection invalidation.
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
