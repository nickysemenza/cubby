---
name: decision-grading
description: Measure Cubby's Jev/Clef decisions and Email relevance from a Claude/Codex session over Cubby MCP — grade samples, replay records through each decision model, compare before/after a prompt or option change. Use when calibrating field suggestions, Email triage, the Jev/Clef traffic split, or option sets.
---

# Decision grading

Every step runs through Cubby MCP; there is no eval script, database URL or
local AI key. Inference runs server-side under the household's paid caps, so
size samples deliberately (a few hundred calls, not thousands).

## Rules

- Report aggregates only. Record ids, shortcodes, subjects, senders, bodies
  and values never enter the repository, commit messages or PR text; use
  synthetic examples when a failure needs illustrating.
- Your grade is a strong model's opinion, not ground truth. Grade offline in
  the session. `mail.accuracy_grade` records a **member** grade, so call it
  only for items the member confirmed in this session.
- Grade blind: read the item before its prediction (`imports_read.
  email_accuracy_blind`, or the record itself before the suggestion).
- Keep originals immutable. Never use `mail.reclassify`, `accept_suggestion`
  or `reject_suggestion` to measure; they write.

## Field decisions (Jev vs Clef, prompts, options)

1. Labels: `entity_read.suggestion_queue` with `status: "applied"` and
   `status: "rejected"`, `minConfidence: 0`, filtered by `entity`/`field`.
   Applied means the suggested value is correct; rejected with
   `correctValue` makes that value the label; rejected without one only says
   the suggestion was wrong.
2. Replay: for each labeled record, call `entity_read.suggest_fields` with
   `entityId`, `targets: [field]`, `basisMode: "suggested"` and
   `decisionModel` `typesafe/jev`, then `@cf/cloudflare/clef`.
3. Score per field × model: accuracy on labeled rows, repeat misses (same
   wrong value as the stored rejection), mean confidence when right vs wrong,
   and how often confidence ≥ 0.85 was wrong.
4. Option health per field: value counts from `entity_read.list` (or
   `search`) on the entity, plus rejected `correctValue`s grouped by
   suggested → correct. Pairs that are often confused, never-used values and
   values whose meaning (`entities://catalog` / the Decisions catalog on
   `/ai`) does not distinguish them are consolidation candidates.
5. A per-field gap between models smaller than the sample's noise means the
   models are interchangeable; recommend one global `CLEF_TRAFFIC_SHARE`.

## Email relevance

1. `mail.accuracy_sample` freezes a stratified sample (it keeps inclusion
   probabilities); `imports_read.email_accuracy_blind` reads it without
   predictions.
2. Grade each item from `imports_read.mail` (or the member's Gmail
   connector): related means it evidences a household purchase, refund,
   subscription charge or order lifecycle. Missing originals are
   unavailable, never guessed.
3. `imports_read.mail_triage_preview` runs the deployed triage on one Email
   without writing (optionally `decisionModel`). Before/after a change:
   preview the same graded sample before and after it deploys.
4. Report, weighted by inclusion probability: false negatives (purchase
   Email called unrelated — the costly error), false positives, uncertain
   rate, bounded-view size and which incompleteness reasons fired.
   `imports_read.email_accuracy_report` covers member-graded samples.

## Before/after a change

Measure the baseline, make the change, deploy, re-measure the same sample,
then confirm on a fresh held-out sample. Ship a prompt or option change only
when it improves the held-out numbers and the disagreements were
spot-checked with the member.
