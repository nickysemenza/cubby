---
name: decision-grading
description: Measure Cubby's Jev/Clef decisions and Email relevance from a Claude/Codex session over Cubby MCP — grade samples, replay records through each decision model, compare before/after a prompt or option change. Use when calibrating field suggestions, Email triage, the Jev/Clef traffic split, or option sets.
---

# Decision grading

Use Cubby MCP for retained originals and deployed pipeline measurement. For
prompt iteration before deployment, the local live evaluator calls the same
Jev/Clef runner and API Gateway; it requires `AI_GATEWAY_API_KEY` through the
existing local-secret loader. Keep calls sequential and show sample sizes first.

## Rules

- Report aggregates only. Record ids, shortcodes, subjects, senders, bodies
  and values never enter the repository, commit messages or PR text; use
  synthetic examples when a failure needs illustrating.
- Your grade is a strong model's opinion, not ground truth. Grade offline in
  the session. `mail.accuracy_grade` records a **member** grade, so call it
  only for items the member confirmed in this session.
- Grade blind: read the item before its prediction (`imports_read.
  email_accuracy_blind`, or the record itself before the suggestion).
- Read the retained original body for every Email before locking its grade.
  Header-only judgments stay provisional. If predictions were opened first,
  report the body review as retrospective rather than blind.
- Run production MCP reads sequentially; parallel effective-value reads can
  exhaust the connection pool. Show sample sizes and the inference budget before
  replay calls. Keep private worklists and originals in session memory; files
  contain aggregates and synthetic examples only.
- Keep originals immutable. Never use `mail.reclassify`, `accept_suggestion`
  or `reject_suggestion` to measure; they write.

## Field decisions (Jev vs Clef, prompts, options)

1. Sample `entity_read.suggestion_queue` across pending, applied, rejected
   and superseded statuses, `minConfidence: 0`, filtered by `entity`/`field`.
   Luna/Sol may grade any sample independently from its captured evidence.
   Lock the model grade before revealing acceptance or rejection. Keep model
   grades and member labels as separate evidence: automatic application is an
   outcome, member acceptance is a member label, and a member correction records
   their preferred value. Neither determines the model grade. Unknown legacy
   acceptance has no trustworthy automatic/member attribution. Keep generating
   provenance, supersession and acceptance receipts with the sampled outcome.
2. Replay: for each sampled record, call `entity_read.suggest_fields` with
   `entityId`, `targets: [field]`, `basisMode: "suggested"` and
   `decisionModel` `typesafe/jev`, then `@cf/cloudflare/clef`.
3. Score per field × model: accuracy against independent grades and member
   labels separately, repeat misses (same
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

1. Get member approval before `mail.accuracy_sample` freezes a stratified sample
   (it keeps inclusion probabilities); `imports_read.email_accuracy_blind` reads
   it without predictions.
2. Grade each item from `imports_read.mail` (or the member's Gmail
   connector), using [Relevance](../../../docs/guide/terminology.md#purchase-research)
   as the label contract. Missing originals are unavailable, never guessed.
   Lock grades before opening predictions. If the member changes the label
   contract after scoring, preserve the original blind grades and report the
   policy-adjusted scores separately.
3. `imports_read.mail_triage_preview` runs the deployed triage on one Email
   without writing (optionally `decisionModel`). Before/after a change:
   preview the same graded sample before and after it deploys.
4. Report, weighted by inclusion probability: false negatives (related
   Email called unrelated — the costly error), false positives, uncertain
   rate, bounded-view size and which incompleteness reasons fired.
   After grades are locked, `imports_read.email_accuracy_report.items` joins
   the blind roster by `predictionId` and gives each frozen inclusion probability
   and inverse-probability weight. Use these weights for session-only grades and
   fresh previews; the report's confusion matrices cover member-graded samples.
   Report unavailable originals, ambiguous grades, and unpredicted population
   coverage separately. Never substitute current routing fields for frozen weights.

## Before/after a change

Measure the baseline, make the change, deploy, re-measure the same sample,
then confirm on a fresh held-out sample. Ship a prompt or option change only
when it improves the held-out numbers and the disagreements were
spot-checked with the member.

## Local prompt iteration

Run `pnpm --dir apps/web eval:mail-prompts` to compare the checked-out production
prompt with an optional full rules draft supplied as `MAIL_PROMPT_CANDIDATE_RULES`.
Without a draft it checks only the checked-out prompt. Edit the prompt locally
and rerun to iterate without deploying. Synthetic
originals pass through the real normalizer and compactor, including the request
budget. CI sets `MAIL_PROMPT_BASELINE_ONLY=1` and checks the production prompt
through both models on manual CI dispatch only. The informational job is outside
the required merge gate; fork PRs never receive the gateway credential.

`MAIL_PROMPT_EVAL_STAGE=relevance` selects real Luna fallback calls;
`both` also runs Jev/Clef, and the default `decision` keeps the CI suite small.
Fallback reports distinguish raw model choices from completeness-guarded results.
Calls use the production feature/schema with no database usage context; this is
prompt measurement, not production execution-authorization or accounting parity.
The stdin source format evaluates body/HTML only, not Gmail attachments.

Read real originals via Cubby or Gmail MCP and lock session labels first. Remove
identifying headers and addresses, preserving transaction evidence. Supply the
JSON array of `{label, body, html?, subject?}` through the stdin wrapper
(`pnpm --dir apps/web eval:mail-prompts:stdin`); never put member inputs in case
files or command arguments. The wrapper transfers input through an ephemeral loopback socket, avoiding
environment-size limits. Input stays in process memory; logs and reports
contain aggregates. CI refuses custom member inputs. Catalog-based cost is an
estimate, not a billing receipt. Confirm a candidate on fresh held-out sources
and then deployed MCP previews before claiming population improvement.
