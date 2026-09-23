# Household ledger attribution follow-ups

Status: **proposed**. Design agreed 2026-09-22 in a design-review session run
against `main` at `537d853c6`. It follows the household contribution ledger
([architecture](../household-contribution-ledger.md)), which shipped the
model; this plan closes the gaps found when planning a first real group-trip
import. Phase 4 (backlog hygiene) landed with this plan; Phases 1–3 are not
implemented yet. Execution: the main session, one implementation PR, phases in
order.

## 1. Summary

The ledger can already say who consumed an Expense and who first paid for it,
and both the web and native editors can set that one expense at a time. Four
things are still missing for a shared-cost import to be pleasant and correct:

1. **Bulk attribution.** Setting the same beneficiary or funder set across many
   expenses (a trip's shared lines) is one-row-at-a-time today.
2. **Gaps you can act on in bulk.** The reports list attribution gaps, and
   per-expense targets already link to each expense, but there is no way to open
   "every expense with this gap" in the ledger and fix them together.
3. **Importer guidance.** The shared `purchase-import` skill has no vocabulary
   for person-to-person repayments, so an agent handed a statement or a payment
   app export would book a friend's repayment as a negative Expense.
4. **Backlog drift.** One todo entry described native editor behavior that was
   no longer true, and one was not written in synthetic terms. Fixed with this
   plan (§7).

No schema migration is needed: every change is code, generated bindings, docs,
and tests.

## 2. What already exists

Verified on `main` at `537d853c6`. Do not rebuild any of this.

- **Storage and write path.** Expense `beneficiaries` and `funders` are arrays of
  `{ partyId | null, weight }` stored in `ExpenseAttribution`. They are written
  only by `replaceExpenseAttributionRole`
  (`apps/web/src/server/repo/expense-attribution.ts`): it locks the referenced
  `LedgerParty` rows, soft-deletes the role's live rows for that expense, and
  inserts the replacements, inside the caller's transaction. It does **not**
  audit; the single-record path audits around it via `auditNestedChanges` in
  `apps/web/src/server/repo/expense/crud.ts`.
- **Editors.** Web: `LedgerAttributionsField`
  (`apps/web/src/entities/editing/ledger-attributions-field.tsx`), registered as
  the `ledger-attributions` specialized renderer in
  `apps/web/src/entities/editing/entity-primitive-fields.tsx`. Native:
  `apps/apple/App/Shared/Editors/LedgerAttributionsControl.swift`, listed as
  implemented in `NativePresentationCoverage.swift`.
- **Fallbacks.** In `apps/web/src/server/repo/household-contribution/allocation.ts`,
  a funder with no explicit row is derived from the paying account's
  `FinancialAccount.ledgerPartyId`, and a beneficiary with no explicit row
  defaults to the Household party (`assumed_household`). Ordinary household
  spending therefore needs no tagging; only costs shared with guests do.
- **Gaps.** Codes live in `packages/schemas/src/household-contribution.ts` and
  are computed by `attributionGaps()` in
  `apps/web/src/server/repo/household-contribution/reports.ts`. Per-expense
  codes carry expense shortcodes in `targetIds`. `beneficiary_assumed_household`
  and `funder_not_yet_paid` are **aggregated**: a count with empty `targetIds`,
  because assumed-household can cover most of the ledger.
- **Per-target links.** `ContributionGapTargets`
  (`apps/web/src/app/_components/household-contribution-format.tsx`) already
  links each `EXP-` target to its detail page, on both the project section and
  the household ledger page.
- **Filter pattern.** The expense list's `ledgerPartyId` filter (either role) is
  implemented in `buildExpenseWhereClause`
  (`apps/web/src/server/repo/expense/lookup.ts`) as an `EXISTS` over
  `ExpenseAttribution` joined to a live `LedgerParty`.
- **Bulk path.** The expense definition
  (`packages/schemas/src/entity-definitions/16-expense.entity.ts`) declares
  `bulkUpdate: { fields: ["projectId", "trade", "costType", "date"] }`.
  `pnpm generate` emits a `.pick()` of `expenseUpdateData` into
  `apps/web/src/server/generated/entity-bindings.gen.ts`; the kernel workflow in
  `apps/web/src/server/entity-kernel/entity-operations.ts` validates against it
  and calls `expenseEntityAdapter.repository.bulkUpdate`
  (`apps/web/src/server/repo/expense/entity-adapter.ts`), which calls
  `updateExpensesInBulk` in `crud.ts`. That function is typed to the four
  scalars and writes them with one `.set()`. The web surface is
  `apps/web/src/app/_components/actions/bulk-edit-entity-action.tsx`.
- **Import pipeline.** The Flue agent imports only
  `.claude/skills/purchase-import/SKILL.md`
  (`apps/purchase-agent/src/purchase-import-run.ts`), **not** its `references/`.
  Gmail sync targets are vendor order senders only; nothing ingests
  person-to-person payments, and the only negative-Expense write path is the
  `create_refund` fix for vendor-order refunds.

## 3. Decisions

Settled; do not relitigate without new evidence.

| Decision                                                                                      | Why                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope is bulk attribution, bulk gap links, importer guidance, and backlog fixes               | Group trips are rare. The editors already exist on web and native.                                                                                   |
| Code ships before the first real group-trip import, in one PR                                 | The import then exercises the finished tools.                                                                                                        |
| Bulk is **replace per role**. Each role is optional; `[]` clears the role                     | Covers the real use ("these lines are shared by these people, equally"). Add/remove modes need a weight-conflict rule and have no use case yet.      |
| Bulk goes through the **generic kernel**, with a narrow nested-field hook                     | One bulk path; MCP and web both inherit it. Not a bespoke tool.                                                                                      |
| Bulk is the whole friction MVP                                                                | Funders are usually derived and beneficiaries default to household, so tagging is limited to shared costs. Project defaults and prefill are backlog. |
| Name anyone who pays you back; use an unattributed share only for truly anonymous consumption | A `LedgerTransfer` cannot reference an unknown party. An unattributed share leaves household totals correct but shows a `partial_*` gap. No pools.   |
| Repayment handling is guidance only                                                           | The pipeline never sees person-to-person payments. When discovery is built it must be review-only (`CONTEXT.md` avoids "automatic match").           |
| The household page links per-expense gap codes only; the project section links every code     | On the household page, assumed-household is the designed default and covers most of the ledger. Inside a shared-cost project it is usually wrong.    |
| The gap filter and the reports share **one** gap definition                                   | Two hand-written predicates would drift, and the links would open lists that disagree with the counts.                                               |

## 4. Phase 1 — Bulk attribution

**Contract.** The expense `bulkUpdate` data gains two optional fields,
`beneficiaries` and `funders`, using the existing `ledgerAttributions` schema.
For each role independently:

- omitted: the role is untouched;
- `[]`: the role is cleared (every live row for that role is soft-deleted);
- non-empty: the role is replaced, on every selected expense, by that exact set.

They may be combined with the existing scalar fields in one call. The existing
bulk id cap applies.

**Steps.**

1. **Declaration.** Declare nested replace fields separately from scalar columns
   so nothing can route them into `.set()` — for example
   `bulkUpdate: { fields: [...], nested: ["beneficiaries", "funders"] }`. Teach
   the generator (`scripts/generator/`) to include declared nested fields in the
   emitted bulk input schema. Run `pnpm generate`; `pnpm generate:check` must
   pass.
2. **Kernel.** The kernel stays unaware of nested semantics and passes the
   validated patch to the adapter. Audit any kernel step that assumes every bulk
   field is a column (field lists, detached-image cleanup, audit field lists) and
   make it skip declared nested fields.
3. **Repository.** Extend `updateExpensesInBulk` to accept the optional roles.
   Inside its existing single transaction: resolve and lock the live expense ids
   (as today), apply the scalar `.set()` when scalars are present, then call
   `replaceExpenseAttributionRole` for each expense and each supplied role.
   Resolve party shortcodes once. An unknown or deleted party fails the **whole**
   batch with no writes.
4. **Audit.** For each expense, record the before/after set for each replaced
   role, and only when it actually changed. Reuse the single-record nested audit
   shape rather than inventing a bulk-only one. If the definition's audited
   `bulk` field list drives the diff, add the roles there.
5. **Invalidation.** Confirm the post-commit fan-out invalidates whatever the
   project contribution section and household ledger page read, so both refresh
   after a bulk change.
6. **MCP.** The `entity` tool's `bulkUpdate` schema picks up the fields from
   codegen. Update any tool description or prose that lists expense bulk fields.
7. **Web.** The bulk dialog must render `beneficiaries` and `funders` through the
   **same** specialized-renderer dispatch as the entity editor, not a bulk-only
   control. It must distinguish "leave unchanged" from "clear", and say plainly
   that a set **replaces** the role on N expenses.

## 5. Phase 2 — Gap filter and bulk links

1. **Filter.** Add an expense-list filter `attributionGap`: a multi-value enum of
   gap codes, declared in the expense definition's filters and implemented in
   `buildExpenseWhereClause`, following the `ledgerPartyId` pattern.
2. **One definition.** The filter must derive membership from the **same**
   allocation rows the reports use, not from a second hand-written predicate.
   Preferred shape: extract the per-expense allocation rows in `allocation.ts`
   as a reusable SQL fragment, and express each gap code once as a rule over
   those rows (`basis`, null party, cost), used by both `attributionGaps()` and
   the filter. If a code cannot be expressed that way, keep it out of the filter
   rather than approximate it.
3. **Scope.** A link must reproduce the scope of the report it came from: the
   project (and subprojects) for the project section; the as-of date and the
   exclusion of future expenses for the household page. Counts in the report and
   rows in the opened list must match.
4. **Links.** Each gap row gets an "Open N in expenses" link to the expense list
   filtered by that code and scope, where the user can select all and use the
   Phase 1 bulk action.
   - **Project section:** every code, including the aggregated ones.
   - **Household ledger page:** per-expense codes only; no link for
     `beneficiary_assumed_household`. (`funder_not_yet_paid` appears only in
     project reports.)
   - Keep the existing per-target links from `ContributionGapTargets`.

## 6. Phase 3 — Importer guidance

1. **`SKILL.md` — inline rule.** Because the Flue agent loads only `SKILL.md`,
   state the rule there in a few sentences: a person-to-person repayment is a
   `LedgerTransfer` between parties, never a negative Expense and never a
   refund; a vendor refund stays a negative Expense (a Credit). Point to the
   reference for everything else.
2. **New `.claude/skills/purchase-import/references/household-ledger.md`**, the
   usage guide for people and agents:
   - the decision rule between a Credit and a Ledger Transfer;
   - `funders` and `beneficiaries`, weights, and unattributed shares;
   - the fallbacks (derived funder, assumed household), and therefore when
     tagging is needed at all;
   - guest-funded expenses (a guest paid the vendor);
   - the naming convention from §3, and what an unattributed share does to the
     reports;
   - importing a shared-expense group export (such as Splitwise): payer to
     funder, shares to beneficiary weights, "X paid Y" rows to Ledger Transfers,
     and source claims whose provider id is derived from date, description and
     amount because the export has no row id — with the re-export dedupe caveat;
   - using the Phase 1 bulk action and Phase 2 links for many rows;
   - reading the reports: project reports show original exposure and do not
     apply transfers; the household ledger does;
   - two worked examples with **synthetic** people and amounts: a multi-day trip
     (one guest-funded line, one weighted line, repayments) and a group dinner
     (one payer, four guests, repayments).
3. **`docs/household-contribution-ledger.md`:** link the reference as the usage
   guide; keep the architecture doc about architecture.

## 7. Phase 4 — Backlog hygiene (`docs/todos.md`) — done

Landed with this plan.

1. **Fixed "Native specialized-renderer editors".** Removed expense
   `beneficiaries` and `funders` (implemented natively). Replaced "silently left
   out": each remaining field's renderer was re-checked, and unsupported
   renderers show "Additional fields are available on web" in
   `EntityEditorSheet` via `NativePresentationCoverage`.
2. **Rewrote the re-export dedupe entry** ("Shared-expense export re-import
   dedupe") in synthetic terms and as a condition.
3. **Added "Person-to-person repayment discovery"** — promote when entering
   transfers by hand becomes a chore. Sources: already-imported aggregator
   statement rows with person-to-person payments that were never promoted to
   Financial Transactions, and Gmail "paid you" emails. It must be review-only:
   propose, a human confirms, and confirmation creates the `LedgerTransfer` and
   its source claim. No automatic counterparty resolution.
4. **Added "Project default beneficiaries"** — promote if shared-cost projects
   become frequent. It would be a fallback tier (explicit, then project default,
   then household), following the live-inheritance pattern.
5. **Added "Attribution prefill"** — the last set used with the same vendor, as an
   editor default. Promote with the same evidence as (4).

## 8. Out of scope

A Splitwise importer or any batch importer; ingesting person-to-person payments;
project default beneficiaries; split presets; add/remove bulk modes; pools or a
reusable "others" party; payer attribution on `Purchase`.

## 9. Tests

Each must fail on a behavior regression the type system cannot catch;
consolidate same-shape cases into table-driven tests.

- **Bulk** (integration, alongside the existing `bulkUpdate` cases in
  `apps/web/src/server/repo/expense.integration.test.ts`): both roles replaced
  on every id in one transaction; an omitted role untouched; `[]` clears; an
  unknown or deleted party fails the batch with no writes; scalar and nested
  fields in one call; audit written only for expenses that changed.
- **Filter/report parity** (integration, with
  `apps/web/src/server/repo/household-contribution/reports.integration.test.ts`):
  a fixture that produces every gap code, run under project and household
  scopes. For per-expense codes the filtered ids equal `targetIds`; for
  aggregated codes the filtered count equals the report count. Table-driven over
  codes and scopes.
- **Links** (UI unit, extending
  `apps/web/src/app/projects/project-contribution-section.unit.test.tsx` and the
  household ledger test): the project section links every code; the household
  page links no assumed-household row; each link carries the report's scope.

## 10. Validation and done

Follow [validation](../agents/validation.md): `pnpm generate:check`,
`pnpm typecheck`, and `pnpm test:file` for touched tests while iterating; the
integration tier needs `docker compose -p cubby up -d`; `pnpm check` before the
PR. All repository text uses synthetic data.

- [ ] `pnpm generate:check` and `pnpm check` pass
- [ ] Bulk replace works from MCP `entity` `bulkUpdate` and from the web bulk
      dialog, for each role independently, with clear and no-op distinguished
- [ ] The filter/report parity test passes for every code under both scopes
- [ ] Gap links follow §5.4 and open lists whose counts match the report
- [ ] `SKILL.md` carries the inline repayment rule; the reference guide exists
      and the architecture doc links it
- [x] `docs/todos.md` updated per §7
