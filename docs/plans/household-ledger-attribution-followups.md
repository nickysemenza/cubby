# Household ledger attribution follow-ups

Status: **proposed**. Design agreed 2026-09-22 in a design-review session run
against `main` at `537d853c6`. It follows the household contribution ledger
([architecture](../household-contribution-ledger.md)), which shipped the
model; this plan closes the gaps found when planning a first real group-trip
import. Bulk attribution, gap links and importer guidance remain proposed. Execution: the main session, one implementation PR, phases in
order.

## 1. Summary

The ledger can already say who consumed an Expense and who first paid for it,
and both the web and native editors can set that one expense at a time. Three
things are still missing for a shared-cost import to be pleasant and correct:

1. **Bulk attribution.** Setting the same beneficiary or funder set across many
   expenses (a trip's shared lines) is one-row-at-a-time today.
2. **Gaps you can act on in bulk.** The reports list attribution gaps, and
   per-expense targets already link to each expense, but there is no way to open
   "every expense with this gap" in the ledger and fix them together.
3. **Importer guidance.** The shared `purchase-import` skill has no vocabulary
   for person-to-person repayments, so an agent handed a statement or a payment
   app export would book a friend's repayment as a negative Expense.

No schema migration is needed: every change is code, generated bindings, docs,
and tests.

## 2. Existing contract

[Household contribution ledger](../household-contribution-ledger.md) owns the
current model; declarations and repository code own field rosters. Reuse the
existing attribution editors, `replaceExpenseAttributionRole`, allocation
fallbacks, gap reports and generic bulk path. Trace their current audit and
invalidation behavior before implementing this proposal; the design review's
old source inventory is not a current implementation claim.

## 3. Decisions

Settled; do not relitigate without new evidence.

| Decision                                                                                      | Why                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope is bulk attribution, bulk gap links and importer guidance                               | Group trips are rare. The editors already exist on web and native.                                                                                        |
| Code ships before the first real group-trip import, in one PR                                 | The import then exercises the finished tools.                                                                                                             |
| Bulk is **replace per role**. Each role is optional; `[]` clears the role                     | Covers the real use ("these lines are shared by these people, equally"). Add/remove modes need a weight-conflict rule and have no use case yet.           |
| Bulk goes through the **generic kernel**, with a narrow nested-field hook                     | One bulk path; MCP and web both inherit it. Not a bespoke tool.                                                                                           |
| Bulk is the whole friction MVP                                                                | Funders are usually derived and beneficiaries default to household, so tagging is limited to shared costs. Project defaults and prefill are backlog.      |
| Name anyone who pays you back; use an unattributed share only for truly anonymous consumption | A `LedgerTransfer` cannot reference an unknown party. An unattributed share leaves household totals correct but shows a `partial_*` gap. No pools.        |
| Repayment handling is guidance only                                                           | The pipeline never sees person-to-person payments. When discovery is built it must be review-only (`docs/guide/terminology.md` avoids "automatic match"). |
| The household page links per-expense gap codes only; the project section links every code     | On the household page, assumed-household is the designed default and covers most of the ledger. Inside a shared-cost project it is usually wrong.         |
| The gap filter and the reports share **one** gap definition                                   | Two hand-written predicates would drift, and the links would open lists that disagree with the counts.                                                    |

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
   emitted bulk input schema. Run `pnpm generate`; `pnpm check:clean` must
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

1. **`SKILL.md` — inline rule.** Because the import-run agent loads only `SKILL.md`,
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
  `apps/web/tests/e2e/project-contribution.spec.ts` and the
  household ledger test): the project section links every code; the household
  page links no assumed-household row; each link carries the report's scope.

## 10. Validation and done

Follow [validation](../agents/validation.md): `pnpm generate`,
`pnpm typecheck`, and `pnpm test:file` for touched tests while iterating; the
integration tier provisions Apple `container` services on macOS; Linux uses
externally managed PostgreSQL/IntegreSQL. Follow the validation policy for the
required PR checks. All repository text uses synthetic data.

- [ ] `pnpm generate` leaves the tree clean and `pnpm check` passes
- [ ] Bulk replace works from MCP `entity` `bulkUpdate` and from the web bulk
      dialog, for each role independently, with clear and no-op distinguished
- [ ] The filter/report parity test passes for every code under both scopes
- [ ] Gap links follow §5.4 and open lists whose counts match the report
- [ ] `SKILL.md` carries the inline repayment rule; the reference guide exists
      and the architecture doc links it
