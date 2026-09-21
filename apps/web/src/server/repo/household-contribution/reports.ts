import {
  type HouseholdContributionLedgerInput,
  type HouseholdContributionLedgerOut,
  householdContributionLedgerOut,
  type ProjectContributionInput,
  type ProjectContributionOut,
  projectContributionOut,
} from "@cubby/schemas/household-contribution";
import type { LedgerPartyId, ProjectId } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, lte, sql } from "drizzle-orm";

import { householdLocalDate } from "~/lib/household-date";
import { splitExpenseSpend } from "~/lib/spend";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  expense,
  financialTransaction,
  ledgerParty,
  ledgerTransfer,
} from "~/server/db/schema";
import {
  notDeleted,
  unwrapDb,
  uuidArrayParam,
} from "~/server/repo/database-helpers";
import { expenseProjectAllocationSql } from "~/server/repo/expense-project-allocation";
import {
  collectDescendantIds,
  loadProjectTree,
} from "~/server/repo/project/subtree";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import {
  type ExpenseAllocationRow,
  type ExpenseAllocationScope,
  loadExpenseAllocations,
} from "./allocation";

type Party = HouseholdContributionLedgerOut["parties"][number]["party"];
type Gap = HouseholdContributionLedgerOut["gaps"][number];

const money = (cents: bigint): number => Number(cents) / 100;
const sum = (values: Iterable<bigint>): bigint => {
  let total = 0n;
  for (const value of values) total += value;
  return total;
};

type PartyDirectory = {
  parties: Map<LedgerPartyId, Party>;
};

async function loadPartyDirectory(
  db: Database | DrizzleTransaction,
): Promise<PartyDirectory> {
  const rows = await unwrapDb(db)
    .select({
      id: ledgerParty.id,
      shortcode: ledgerParty.shortcode,
      name: ledgerParty.name,
      kind: ledgerParty.kind,
    })
    .from(ledgerParty)
    .where(notDeleted(ledgerParty));

  const parties = new Map<LedgerPartyId, Party>();
  for (const row of rows) {
    parties.set(row.id, {
      id: parseShortcodeFor("ledgerParty", row.shortcode),
      name: row.name,
      kind: row.kind,
    });
  }
  return { parties };
}

type ExpenseFact = {
  shortcode: string;
  costCents: string | null;
  future: boolean;
};

async function loadExpenseFacts(
  db: Database | DrizzleTransaction,
  scope: ExpenseAllocationScope,
): Promise<ExpenseFact[]> {
  if (scope.projectIds?.length === 0) return [];
  const result = await unwrapDb(db).execute<ExpenseFact>(sql`
    SELECT
      ${expense.shortcode} AS shortcode,
      ${
        scope.projectIds
          ? sql`(SELECT sum(project_allocation."attributedCents"::bigint)::text
            FROM (${expenseProjectAllocationSql()}) project_allocation
            WHERE project_allocation."expenseId" = ${expense.id}
              AND project_allocation."projectId" = ANY(${uuidArrayParam(scope.projectIds)}))`
          : sql`CASE WHEN ${expense.cost} IS NULL THEN NULL
            ELSE round((${expense.cost})::numeric * 100)::bigint::text END`
      } AS "costCents",
      ${expense.future} AS future
    FROM ${expense}
    WHERE ${and(
      notDeleted(expense),
      scope.asOf ? lte(expense.date, scope.asOf) : undefined,
      scope.includeFuture ? undefined : sql`${expense.future} = false`,
      scope.projectIds
        ? sql`EXISTS (
            SELECT 1 FROM (${expenseProjectAllocationSql()}) project_allocation
            WHERE project_allocation."expenseId" = ${expense.id}
              AND project_allocation."projectId" = ANY(${uuidArrayParam(scope.projectIds)})
          )`
        : undefined,
    )}
  `);
  return result.rows;
}

/**
 * Turn allocation rows into user-facing gaps.
 *
 * The `recorded`/`unknown` branch is the pre-existing behaviour, untouched:
 * an explicit null-party row alongside a real one is `partial_*`, a wholly
 * unattributed role is `missing_*`. The two derived bases are independent
 * checks on top.
 *
 * `assumed_household` is AGGREGATED by the caller — it can cover thousands of
 * expenses and enumerating them is the noise this work removes — while
 * `unowned_account` keeps its targets, because there the specific expense (and
 * the account behind it) is worth opening.
 */
function attributionGaps(rows: ExpenseAllocationRow[]): Gap[] {
  const grouped = new Map<string, ExpenseAllocationRow[]>();
  for (const row of rows) {
    const key = `${row.expenseId}:${row.role}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else grouped.set(key, [row]);
  }
  const gaps: Gap[] = [];
  let assumedCount = 0;
  let assumedCents = 0n;
  let notYetPaidCount = 0;
  let notYetPaidCents = 0n;
  for (const bucket of grouped.values()) {
    const first = bucket[0];
    if (!first) continue;
    const target = parseShortcodeFor("expense", first.expenseShortcode);

    // Scoped to the two bases that predate derivation, so the legacy
    // missing/partial distinction keeps meaning exactly what it did.
    const attributable = bucket.filter(
      (row) => row.basis === "recorded" || row.basis === "unknown",
    );
    const nullRows = attributable.filter((row) => !row.ledgerPartyId);
    if (nullRows.length > 0) {
      const nullCents = sum(nullRows.map((row) => row.cents));
      const unknown = nullRows.some((row) => row.basis === "unknown");
      gaps.push({
        code:
          first.role === "beneficiary"
            ? unknown
              ? "missing_beneficiaries"
              : "partial_beneficiaries"
            : unknown
              ? "missing_funders"
              : "partial_funders",
        amount: money(nullCents),
        targetIds: [target],
      });
    }

    // Arm C only fires when no explicit beneficiary row exists, so an assumed
    // row is always the whole beneficiary allocation for that expense.
    const assumed = bucket.filter((row) => row.basis === "assumed_household");
    if (assumed.length > 0) {
      assumedCount += 1;
      assumedCents += sum(assumed.map((row) => row.cents));
    }

    // Same aggregation, same reason: a scheduled instalment is a status, not a
    // worklist entry. Only the project report can produce these — the household
    // ledger scopes future rows out before allocation.
    const notYetPaid = bucket.filter((row) => row.basis === "not_yet_paid");
    if (notYetPaid.length > 0) {
      notYetPaidCount += 1;
      notYetPaidCents += sum(notYetPaid.map((row) => row.cents));
    }

    // Can legitimately coexist with `derived_from_payment` rows when one order
    // was part-paid from an owned card and part from an orphan account, so sum
    // only the unowned rows rather than the whole bucket.
    const unowned = bucket.filter((row) => row.basis === "unowned_account");
    if (unowned.length > 0) {
      gaps.push({
        code: "funder_account_unowned",
        amount: money(sum(unowned.map((row) => row.cents))),
        targetIds: [target],
      });
    }
  }
  if (assumedCount > 0) {
    gaps.push({
      code: "beneficiary_assumed_household",
      amount: money(assumedCents),
      count: assumedCount,
      targetIds: [],
    });
  }
  if (notYetPaidCount > 0) {
    gaps.push({
      code: "funder_not_yet_paid",
      amount: money(notYetPaidCents),
      count: notYetPaidCount,
      targetIds: [],
    });
  }
  return gaps;
}

type TransferRow = {
  shortcode: string;
  fromPartyId: LedgerPartyId;
  toPartyId: LedgerPartyId;
  cents: string;
  evidenceCount: number;
};

async function loadTransfers(
  db: Database | DrizzleTransaction,
  asOf: string,
): Promise<TransferRow[]> {
  const result = await unwrapDb(db).execute<TransferRow>(sql`
    SELECT
      t.shortcode,
      t."fromPartyId",
      t."toPartyId",
      round(t.amount::numeric * 100)::bigint::text AS cents,
      count(e.id)::int AS "evidenceCount"
    FROM ${ledgerTransfer} t
    LEFT JOIN ${financialTransaction} e
      ON e."ledgerTransferId" = t.id AND e."deletedAt" IS NULL
    WHERE t."deletedAt" IS NULL AND t.date <= ${asOf}
    GROUP BY t.id
    ORDER BY t.date, t.shortcode
  `);
  return result.rows;
}

export async function householdContributionLedger(
  db: Database,
  input: HouseholdContributionLedgerInput,
): Promise<HouseholdContributionLedgerOut> {
  const asOf = input.asOf ?? householdLocalDate();
  const scope = { asOf, includeFuture: false } satisfies ExpenseAllocationScope;
  const [directory, allocations, expenseFacts, transfers] = await Promise.all([
    loadPartyDirectory(db),
    loadExpenseAllocations(db, scope),
    loadExpenseFacts(db, scope),
    loadTransfers(db, asOf),
  ]);

  const balances = new Map<
    LedgerPartyId,
    {
      consumed: bigint;
      initiallyOutlaid: bigint;
      sent: bigint;
      received: bigint;
    }
  >();
  for (const sourceId of directory.parties.keys()) {
    balances.set(sourceId, {
      consumed: 0n,
      initiallyOutlaid: 0n,
      sent: 0n,
      received: 0n,
    });
  }

  let unattributedConsumption = 0n;
  let unattributedFunding = 0n;
  for (const row of allocations) {
    const balance = row.ledgerPartyId
      ? balances.get(row.ledgerPartyId)
      : undefined;
    if (!balance) {
      if (row.role === "beneficiary") unattributedConsumption += row.cents;
      else unattributedFunding += row.cents;
    } else if (row.role === "beneficiary") {
      balance.consumed += row.cents;
    } else {
      balance.initiallyOutlaid += row.cents;
    }
  }

  const transferGaps: Gap[] = [];
  for (const transfer of transfers) {
    const cents = BigInt(transfer.cents);
    const from = balances.get(transfer.fromPartyId);
    const to = balances.get(transfer.toPartyId);
    if (from) from.sent += cents;
    if (to) to.received += cents;
    if (Number(transfer.evidenceCount) === 1) {
      transferGaps.push({
        code: "transfer_evidence_one_sided",
        amount: money(cents),
        targetIds: [parseShortcodeFor("ledgerTransfer", transfer.shortcode)],
      });
    }
  }

  const fundingParties = [...directory.parties.entries()].map(
    ([sourceId, party]) => {
      const balance = balances.get(sourceId);
      if (!balance)
        throw new Error("Funding party balance was not initialized");
      const netContribution =
        balance.initiallyOutlaid + balance.sent - balance.received;
      return {
        party,
        consumed: money(balance.consumed),
        initiallyOutlaid: money(balance.initiallyOutlaid),
        transfersSent: money(balance.sent),
        transfersReceived: money(balance.received),
        netContribution: money(netContribution),
        position: money(netContribution - balance.consumed),
      };
    },
  );
  const parties: HouseholdContributionLedgerOut["parties"] = [
    ...fundingParties,
  ].sort((a, b) => a.party.name.localeCompare(b.party.name));

  const expenseTotalCents = sum(
    expenseFacts.flatMap((row) =>
      row.costCents === null ? [] : [BigInt(row.costCents)],
    ),
  );
  const consumedTotalCents = sum(
    [...balances.values()].map((row) => row.consumed),
  );
  const fundedTotalCents = sum(
    [...balances.values()].map((row) => row.initiallyOutlaid),
  );
  const transferNetCents = sum(
    [...balances.values()].map((row) => row.sent - row.received),
  );
  const positionNetCents = sum(
    [...balances.values()].map(
      (row) => row.initiallyOutlaid + row.sent - row.received - row.consumed,
    ),
  );
  const unpricedGaps: Gap[] = expenseFacts
    .filter((row) => row.costCents === null)
    .map((row) => ({
      code: "unpriced_expense",
      targetIds: [parseShortcodeFor("expense", row.shortcode)],
    }));
  const allGaps = [
    ...attributionGaps(allocations),
    ...unpricedGaps,
    ...transferGaps,
  ];
  const gapLimit = 200;

  return householdContributionLedgerOut.parse({
    asOf,
    parties,
    unattributed: {
      consumption: money(unattributedConsumption),
      funding: money(unattributedFunding),
    },
    checks: {
      expenseTotal: money(expenseTotalCents),
      consumedTotal: money(consumedTotalCents),
      fundedTotal: money(fundedTotalCents),
      transferNet: money(transferNetCents),
      positionNet: money(positionNetCents),
    },
    gaps: allGaps.slice(0, gapLimit),
    gapsTruncated: allGaps.length > gapLimit,
  });
}

export async function projectContribution(
  db: Database,
  input: ProjectContributionInput,
): Promise<ProjectContributionOut> {
  const projectId = await resolveOrThrow(db, "project", input.projectId);
  let projectIds: ProjectId[] = [projectId];
  if (input.includeSubprojects) {
    const tree = await loadProjectTree(db);
    projectIds = [
      projectId,
      ...collectDescendantIds(tree.childrenByParent, projectId),
    ];
  }
  const scope = {
    projectIds,
    includeFuture: true,
  } satisfies ExpenseAllocationScope;
  const [directory, allocations, facts] = await Promise.all([
    loadPartyDirectory(db),
    loadExpenseAllocations(db, scope),
    loadExpenseFacts(db, scope),
  ]);

  const consumed = new Map<LedgerPartyId, bigint>();
  const initiallyFunded = new Map<LedgerPartyId, bigint>();
  let unattributedConsumption = 0n;
  let unattributedInitialFunding = 0n;
  for (const row of allocations) {
    if (row.role === "beneficiary") {
      if (row.ledgerPartyId && directory.parties.has(row.ledgerPartyId)) {
        consumed.set(
          row.ledgerPartyId,
          (consumed.get(row.ledgerPartyId) ?? 0n) + row.cents,
        );
      } else {
        unattributedConsumption += row.cents;
      }
    } else if (row.ledgerPartyId && directory.parties.has(row.ledgerPartyId)) {
      initiallyFunded.set(
        row.ledgerPartyId,
        (initiallyFunded.get(row.ledgerPartyId) ?? 0n) + row.cents,
      );
    } else {
      unattributedInitialFunding += row.cents;
    }
  }

  const funders = [...initiallyFunded.entries()]
    .map(([sourceId, cents]) => ({
      party: directory.parties.get(sourceId),
      initiallyFunded: money(cents),
    }))
    .filter((row): row is { party: Party; initiallyFunded: number } =>
      Boolean(row.party),
    )
    .sort((a, b) => a.party.name.localeCompare(b.party.name));
  const householdInitialExposure = sum(
    [...initiallyFunded.entries()].flatMap(([sourceId, cents]) =>
      directory.parties.get(sourceId)?.kind === "household" ? [cents] : [],
    ),
  );
  const guestInitialFunding = sum(
    [...initiallyFunded.entries()].flatMap(([sourceId, cents]) =>
      directory.parties.get(sourceId)?.kind === "guest" ? [cents] : [],
    ),
  );
  const gaps: Gap[] = [
    ...attributionGaps(allocations),
    ...facts
      .filter((row) => row.costCents === null)
      .map((row) => ({
        code: "unpriced_expense" as const,
        targetIds: [parseShortcodeFor("expense", row.shortcode)],
      })),
  ];
  // Same cap the household ledger applies. Without it a project page could
  // ship one entry per expense — 5,717 on the Household project alone.
  const gapLimit = 200;

  // The same decomposition the project page's BudgetStrip already shows, computed
  // from the identical helper so the two panels cannot disagree about what
  // "committed" means. `wholeGroupCost` stays the blended figure it always was.
  const spend = splitExpenseSpend(
    facts.map((row) => ({
      cost: row.costCents === null ? null : Number(BigInt(row.costCents)) / 100,
      future: row.future,
    })),
  );

  return projectContributionOut.parse({
    projectId: input.projectId,
    wholeGroupCost: money(
      sum(
        facts.flatMap((row) =>
          row.costCents === null ? [] : [BigInt(row.costCents)],
        ),
      ),
    ),
    actualSpend: spend.actual,
    committedSpend: spend.committed,
    creditsReceived: spend.contributions,
    householdInitialExposure: money(householdInitialExposure),
    guestInitialFunding: money(guestInitialFunding),
    unattributedConsumption: money(unattributedConsumption),
    unattributedInitialFunding: money(unattributedInitialFunding),
    householdConsumed: money(
      sum(
        [...consumed.entries()].flatMap(([partyId, cents]) =>
          directory.parties.get(partyId)?.kind === "household" ? [cents] : [],
        ),
      ),
    ),
    parties: [...consumed.entries()]
      .map(([partyId, cents]) => ({
        party: directory.parties.get(partyId),
        consumed: money(cents),
      }))
      .filter((row): row is { party: Party; consumed: number } =>
        Boolean(row.party),
      )
      .sort((a, b) => a.party.name.localeCompare(b.party.name)),
    funders,
    gaps: gaps.slice(0, gapLimit),
    gapsTruncated: gaps.length > gapLimit,
  });
}
