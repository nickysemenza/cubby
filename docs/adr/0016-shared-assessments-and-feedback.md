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
