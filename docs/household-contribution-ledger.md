# Household contribution ledger

Status: accepted architecture for the household contribution implementation.

## Decision

Cubby separates four facts that are easy to double-count when collapsed:

1. `Expense.cost` is the actual cost and remains the only source of spend.
2. Expense attribution weights say who consumed the cost and which economic
   source initially covered it.
3. `FundingTransfer` records one later movement between economic sources.
4. `FinancialTransaction` rows are statement evidence only. Two mirrored rows
   may evidence one transfer, but never become two contributions.

Funding transfers are addressed outside Cubby by immutable `FTR-` shortcodes;
their database UUIDs never cross tRPC or MCP. They are intentionally not generic
Entities: the reviewed `HouseholdLedgerImport` envelope is the append-only
activity record for every applied batch, including the normalized changes,
actor, source, fingerprint, and result.

Beneficiary and funder weights contain no money. Reports convert each Expense
to integer cents and use deterministic largest-remainder allocation. A
beneficiary may be a Person, the household as a whole, or an explicit unknown
residual. The household target is intentional attribution—not a synthetic
Person and not an incomplete-data warning. An absent role remains implicitly
fully unattributed.

## Shared accounts

A Person and a FinancialAccount are not the same concept. Account-person rows
describe access or ownership, while `FinancialAccount.fundingSourceId` says
which economic source the account currently evidences.

Joint checking and a shared card paid from it can map to one shared household
fund. Paying that card from that checking is a same-source internal transfer:
both statement facts remain visible and its contribution effect is zero.
Individual credit appears only when an explicit transfer or attributed deposit
moves value from a person's source into the shared fund.

Project kind never implies attribution. Each Expense is explicit: it may
benefit one Person, several weighted People, the household collectively, or an
unknown residual, independently of who funded it. A current shared renovation
Expense paid by shared checking or a shared card can use the household as
beneficiary and the shared fund as original funder, while a historic solo
renovation can name its individual beneficiary and personal funding source. A
trip may likewise benefit either household member, both members at any weights,
or guests. An import may batch-apply one reviewed pattern to many Expenses, but
never infers that pattern from `Project.kind`. Existing Projects and Expenses
are never reclassified automatically. Statement transactions remain account
evidence, not Person assignments, and paying a shared card from shared checking
remains a zero-effect internal account move.

## Reporting boundaries

Project reports show whole-group cost, household initial exposure, guest
initial funding, beneficiary consumption, original funding sources, and gaps.
They never apply later transfers because transfers are household-global.

The household report is cumulative as of a date:

```text
net contribution = initially outlaid + transfers sent - transfers received
position         = net contribution - consumed
```

Internal transfers cancel. Positions remain advisory while attribution or
evidence gaps exist and are never labeled as debts.

## Import boundary

The MCP client reads Splitwise, Gmail, and Monarch. Cubby accepts normalized
changes only:

```text
preview_household_ledger_changes
  -> reviewed fingerprint and per-change status

apply_household_ledger_changes
  -> atomic, idempotent commit or structured refusal
```

The server never receives provider credentials, local file paths, raw emails,
or whole CSV exports. Claiming an Expense source records the external amount,
the Expense amount at claim time, and either an exact match or a noted explicit
decision to retain the existing Expense amount. Ambiguous transfer pairs remain
unpaired. Neither discrepancy is automatically spread or paired.

Expected domain failures (missing records, evidence conflicts, stale previews,
or an idempotency-key mismatch) are returned in the structured refusal branch,
not as a transport failure. A newly created shared fund is deliberately a
two-batch bootstrap: first create and review the fund, then preview and apply a
later batch that maps accounts, attribution, or transfers to it. This keeps a
preview's fingerprint tied to one already-existing funding topology.
