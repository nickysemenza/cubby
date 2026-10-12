# Decision calibration and suggestion review

Status: **planned**. One PR. Covers the `docs/todos.md` entries "Calibrate
Email relevance and reduce false uncertainty", "Re-evaluate categories and
Jev-backed dropdown options", "Tune Jev/Luna prompts from review conflicts" and
"Re-weight the decision trial from paired data", plus the suggestion UI they
need. Delete this file (and the four todos) when the PR lands; durable behavior
moves into `docs/entities.md`, `docs/infrastructure.md` and the glossary.

## Settled decisions

- Measure before changing. Live evals read production through read-only paths;
  only aggregate metrics and synthetic examples enter the repository, commits
  and PR text.
- Web only. Native changes only if a shared wire contract changes shape (then
  bump `APPLE_CLIENT_COMPATIBILITY_VERSION`).
- Prefer generic paths; custom UI only where no record list fits.
- Jev and Clef are assumed interchangeable unless the eval shows a real
  per-field gap. One global `CLEF_TRAFFIC_SHARE` stays (no per-field routing
  table, no persisted eval Runs) unless the numbers force it.
- Mail triage's 50/50 Jev/Clef sampling is intentional trial traffic.
- A Claude/Codex session may grade samples through MCP; labels record their
  grader (member vs agent); a member label supersedes an agent label for the
  same item.
- Option/category consolidation happens in this PR, with a migration that
  carries every existing assignment through. The proposed merge list is shown
  to the member before the migration is written.
- Only an effective evidence expectation of `required` raises a missing
  receipt/document gap; `unknown` keeps its existing classification gap
  (`purchase_evidence_expectation`, `data-quality/checks/purchase.ts:142`).
  Both are already true; this PR only labels rows with the policy source.
- Owner: the main agent implements, owns the migration and runs validation;
  one independent review per the model-routing doc.

## Phase 0 — measure through MCP

There is no eval script. A Claude/Codex session measures with Cubby MCP
reads, following the `decision-grading` skill; inference runs server-side on
the Worker's `AI` binding under the existing paid caps, so no database URL or
local AI key is needed. Three small MCP gaps close first:

1. `entity_read.suggestion_queue` gains a `status` filter (applied,
   rejected, superseded, pending) and returns `correctValue`, so a session
   can read labeled history.
2. `entity_read.suggest_fields` accepts an optional `decisionModel`
   (`jev` | `clef`) so a session can replay the same record through both.
3. `imports_read` gains a read-only triage preview for a stored Email
   (bounded view + routed relevance/stage/model, no write). Before/after is
   the same sample previewed before and after the change deploys.

The direct-Postgres `eval:decisions` live eval
(`apps/web/src/server/ai/decision-eval*.ts`, `DECISION_EVAL_*`, its
`docs/infrastructure.md` section) is deleted; its scoring rules (applied =
correct, rejected + `correctValue` = label, rejected alone = negative) move
into the skill.

Outputs decide: global traffic share, which prompts to revise, which options to
merge, and whether the triage view should grow.

## Phase 1 — Email relevance calibration

- `recipebridge/src/page.rs`: add an Email mode (`compact_email_html`) beside
  `compact_browser_page`, sharing the `scraper` DOM walk:
  - drop hidden text except the preheader (returned separately) and images
    declared 1×1 / zero-size (never by missing alt alone); demote
    footer/unsubscribe blocks to the end;
  - classify data tables (consistent column count with money/quantity cells)
    vs layout tables; render data-table rows as `cell | cell | cell`;
  - rank links by order/receipt/invoice/tracking cues rather than document
    order;
  - scan purchase cues (currency amounts, order/invoice numbers, receipt
    words) on the full text before any truncation; the caller re-checks cue
    presence against the final serialized view rather than trusting offsets.
  - Spike first: compare current compactor, this mode, `html2text`, and `htmd`
    on a synthetic Email fixture set by bytes used and cues retained; adopt a
    renderer crate only if it measurably wins. Run identical fixtures through
    Node/Vitest and workerd (`lib/recipebridge-cf.ts`), confirm the browser
    package excludes it, and record release WASM size/CPU deltas.
- `apps/web/src/server/purchase-import/gmail/triage.ts`:
  - `complete` stops meaning `html === null`. A view is incomplete when any
    of these hold: a purchase cue is missing from the serialized view;
    attachments exist (existing safeguard); images carry pixels the view
    cannot show and no readable text accompanies them (image-only receipts,
    `relevance.ts:36`); links/images/JSON-LD were clipped; the compactor hit
    its text cap; or the normalizer dropped MIME parts (`normalize.ts:69`
    keeps only the first unnamed body — forwarded/multipart mail stays
    incomplete). Otherwise HTML alone no longer forces `uncertain`;
  - no sender-wide exclusions;
  - bound the view with `jevChoiceFitsContext(mailTriagePrompt(candidate))`
    (the real serialized request, including escaping) instead of a fixed
    12 KB; tests cover quotes, backslashes, Unicode, metadata-heavy mail.
- `MAILBOX_TRIAGE` feature: `sample: true` to match the explicit
  `selectDecisionModel()` call; fix the `jev.ts:399` comment.
- Before/after is a read-only replay over the frozen accuracy sample
  (same originals, checksums, labels and inclusion weights), recording the
  new prompt/model version; unavailable items stay explicit. Live Reclassify
  is not the evaluation path. Confirm a tuned prompt on a held-out sample.

## Phase 2 — grading over MCP

- Agent grades stay offline; only member grades persist. A repo skill
  (`.claude/skills/decision-grading/`) tells a Claude/Codex session how to
  draw the stratified sample through existing MCP reads, grade it blind,
  run the replay eval, and report aggregates only.
- The skill uses MCP only: sample through `entity_read`/mail reads, grade
  in-session, replay with the Phase 0 reads, and put aggregates (never
  record ids or content) in the PR.
- Field suggestions already grade through `suggestion_queue` +
  `accept_suggestion(s)` / `reject_suggestion` with `correctValue`.

## Phase 3 — prompts and options

- Revise triage/relevance and field-suggest rules (`registry.ts`
  `FIELD_SUGGEST_OVERRIDES`, manifest `control.suggest.rules`, option
  `description`s) from conflicts and Misses. Ship a change only when the
  re-graded sample improves and disagreements were spot-checked.
- Consolidate clearly overlapping enum options / category nodes after the
  member approves the merge list. For each merged value enumerate SQL
  literals (e.g. `expense-category-resolution.ts:145`), classification
  policies and their generated constraints, category references and
  inheritance, persisted Suggestion values, generated and native consumers.
  The migration transforms live assignments, supersedes pending Suggestions
  for merged values, and leaves historical predictions untouched (the eval
  maps old labels for comparison). Constraint changes deploy after the data
  transform; read back preserved counts after deploy; native compatibility
  checked.
- Set the global `CLEF_TRAFFIC_SHARE` from Phase 0.

## Phase 4 — suggestion UI (generic first)

- Review list: a typed list on the shared table component (not a manifest
  entity; generic child review lists are a `docs/todos.md` item). It calls
  the existing `suggestion-review.ts` handlers (status-before-update
  ordering, paired-row exclusion, finance fingerprints, partial-failure
  results) and keeps the supersede triggers and storage unchanged. MCP
  suggestion actions stay. Bulk Accept uses `acceptSuggestions`; add bulk
  Reject. History reads include `superseded`. "Correct value" writes the
  correction to the record and records the Miss — say so in the UI.
- Work queue: one row per (entity, field) with pending count, linking to the
  filtered Suggestion list (not one row per suggestion). Email rows state the
  specific gap instead of "Email needs attention". Receipt rows state the
  expectation and its source ("Receipt required — inherited from Spending
  category …").
- One suggestion body everywhere: Accept / Reject (+ "Use a different value…"),
  confidence as "92% · high", reasoning visible inline (never `title`),
  provenance caption (model, Run, time → `/ai` Usage). Jev/Clef return no
  reasoning, so "why" is the basis fields the model saw plus the runner-up
  and its probability (already stored); no new column. Table cells keep a
  compact mark opening the same body. Built from `AiProposalCard` and
  `suggestion-review.tsx` bodies; delete the duplicates.
- Sweep Run detail gets a "Review N pending" link and accepted/rejected/pending
  counts.
- `/ai` page with tabs: **Decisions** (catalog), **Review** (Suggestion list),
  **Smoke tests** (existing), **Usage** (moved from `/ai-usage`). Email
  Accuracy stays an Emails view, linked from Decisions.
- Decisions catalog: one row per `suggestFieldKeys` entry plus mail triage /
  relevance, purchase-import decisions, settlement rank and external-id kind.
  Each shows basis fields, options with meanings, rules, the exact rendered
  prompt and input JSON (from `renderSubject` / `buildChoiceInput`, never a
  copy), pending and Miss counts, and a Try panel (existing smoke runner)
  running Jev and Clef side by side. Unit test asserts one row per
  `suggestFieldKeys` entry, like `smoke-catalog.unit.test.ts`.

## Receipt-check audit (visible slice)

Verify which effective expectations create gaps in Problems and the Work queue;
only `required` does. Show the policy source on each row. Full audit stays a
todo.

## Validation

Narrowest checks per `docs/agents/validation.md`: Rust unit tests for the Email
mode on synthetic fixtures; triage unit tests for clipped-cue vs no-cue
routing; catalog coverage unit test; migration tests carrying assignments and
labels; an E2E for Suggestion bulk Accept/Reject; before/after accuracy numbers
in the PR body (aggregates only).
