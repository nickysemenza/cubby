import {
  type HouseholdContributionLedgerInput,
  type HouseholdContributionLedgerOut,
  householdContributionLedgerOut,
  type ProjectContributionInput,
  type ProjectContributionOut,
  projectContributionOut,
} from "@cubby/schemas/household-contribution";
import type {
  FundingSourceId,
  PersonId,
  ProjectId,
} from "@cubby/schemas/identifiers";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { householdLocalDate } from "~/lib/household-date";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  expense,
  financialAccount,
  financialAccountPerson,
  fundingSource,
  person,
} from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
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
  parties: Map<FundingSourceId, Party>;
  personSource: Map<PersonId, FundingSourceId>;
};

async function loadPartyDirectory(
  db: Database | DrizzleTransaction,
): Promise<PartyDirectory> {
  const rows = await unwrapDb(db)
    .select({
      sourceId: fundingSource.id,
      sourceKind: fundingSource.kind,
      personId: fundingSource.personId,
      fundKey: fundingSource.fundKey,
      fundName: fundingSource.name,
      personShortcode: person.shortcode,
      personName: person.name,
      personKind: person.kind,
      personDeletedAt: person.deletedAt,
    })
    .from(fundingSource)
    .leftJoin(person, eq(fundingSource.personId, person.id))
    .where(notDeleted(fundingSource));

  const parties = new Map<FundingSourceId, Party>();
  const personSource = new Map<PersonId, FundingSourceId>();
  for (const row of rows) {
    if (
      row.sourceKind === "person" &&
      row.personId &&
      row.personShortcode &&
      row.personName &&
      row.personKind &&
      !row.personDeletedAt
    ) {
      parties.set(row.sourceId, {
        key: row.personShortcode,
        kind: "person",
        name: row.personName,
        household: row.personKind === "household",
      });
      personSource.set(row.personId, row.sourceId);
    } else if (
      row.sourceKind === "shared_fund" &&
      row.fundKey &&
      row.fundName
    ) {
      parties.set(row.sourceId, {
        key: row.fundKey,
        kind: "shared_fund",
        name: row.fundName,
        household: true,
      });
    }
  }
  return { parties, personSource };
}

type ExpenseFact = {
  id: string;
  shortcode: string;
  costCents: string | null;
};

async function loadExpenseFacts(
  db: Database | DrizzleTransaction,
  scope: ExpenseAllocationScope,
): Promise<ExpenseFact[]> {
  if (scope.projectIds?.length === 0) return [];
  const result = await unwrapDb(db).execute<ExpenseFact>(sql`
    SELECT
      ${expense.id} AS id,
      ${expense.shortcode} AS shortcode,
      CASE WHEN ${expense.cost} IS NULL THEN NULL
        ELSE round((${expense.cost})::numeric * 100)::bigint::text
      END AS "costCents"
    FROM ${expense}
    WHERE ${and(
      notDeleted(expense),
      scope.asOf ? lte(expense.date, scope.asOf) : undefined,
      scope.includeFuture ? undefined : sql`${expense.future} = false`,
      scope.projectIds
        ? inArray(expense.projectId, [...scope.projectIds])
        : undefined,
    )}
  `);
  return result.rows;
}

function allocationPartyId(
  row: ExpenseAllocationRow,
  directory: PartyDirectory,
): FundingSourceId | null {
  if (row.role === "funder") return row.fundingSourceId;
  return row.personId
    ? (directory.personSource.get(row.personId) ?? null)
    : null;
}

function attributionGaps(rows: ExpenseAllocationRow[]): Gap[] {
  const grouped = new Map<string, ExpenseAllocationRow[]>();
  for (const row of rows) {
    const key = `${row.expenseId}:${row.role}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else grouped.set(key, [row]);
  }
  const gaps: Gap[] = [];
  for (const bucket of grouped.values()) {
    const first = bucket[0];
    if (!first) continue;
    const nullRows = bucket.filter(
      (row) => !row.personId && !row.fundingSourceId,
    );
    const nullCents = sum(nullRows.map((row) => row.cents));
    if (nullRows.some((row) => row.implicitUnattributed)) {
      gaps.push({
        code:
          first.role === "beneficiary"
            ? "missing_beneficiaries"
            : "missing_funders",
        amount: money(nullCents),
        targetIds: [first.expenseShortcode],
      });
    } else if (
      nullRows.length > 0 &&
      bucket.some((row) => row.personId || row.fundingSourceId)
    ) {
      gaps.push({
        code:
          first.role === "beneficiary"
            ? "partial_beneficiaries"
            : "partial_funders",
        amount: money(nullCents),
        targetIds: [first.expenseShortcode],
      });
    }
  }
  return gaps;
}

type TransferRow = {
  id: string;
  fromSourceId: FundingSourceId;
  toSourceId: FundingSourceId;
  cents: string;
  evidenceCount: number;
};

async function loadTransfers(
  db: Database | DrizzleTransaction,
  asOf: string,
): Promise<TransferRow[]> {
  const result = await unwrapDb(db).execute<TransferRow>(sql`
    SELECT
      t.id,
      t."fromSourceId",
      t."toSourceId",
      round(t.amount::numeric * 100)::bigint::text AS cents,
      count(e.id)::int AS "evidenceCount"
    FROM "FundingTransfer" t
    LEFT JOIN "FundingTransferEvidence" e
      ON e."transferId" = t.id AND e."deletedAt" IS NULL
    WHERE t."deletedAt" IS NULL AND t.date <= ${asOf}
    GROUP BY t.id
    ORDER BY t.date, t.id
  `);
  return result.rows;
}

async function loadSharedAccountGaps(
  db: Database | DrizzleTransaction,
): Promise<Gap[]> {
  const rows = await unwrapDb(db)
    .select({ id: financialAccount.shortcode })
    .from(financialAccount)
    .innerJoin(
      financialAccountPerson,
      and(
        eq(financialAccountPerson.accountId, financialAccount.id),
        notDeleted(financialAccountPerson),
      ),
    )
    .where(
      and(
        notDeleted(financialAccount),
        sql`${financialAccount.fundingSourceId} IS NULL`,
      ),
    )
    .groupBy(financialAccount.id)
    .having(sql`count(${financialAccountPerson.id}) > 1`);
  return rows.map((row) => ({
    code: "shared_account_unmapped" as const,
    targetIds: [row.id],
  }));
}

export async function householdContributionLedger(
  db: Database,
  input: HouseholdContributionLedgerInput,
): Promise<HouseholdContributionLedgerOut> {
  const asOf = input.asOf ?? householdLocalDate();
  const scope = { asOf, includeFuture: false } satisfies ExpenseAllocationScope;
  const [directory, allocations, expenseFacts, transfers, accountGaps] =
    await Promise.all([
      loadPartyDirectory(db),
      loadExpenseAllocations(db, scope),
      loadExpenseFacts(db, scope),
      loadTransfers(db, asOf),
      loadSharedAccountGaps(db),
    ]);

  const balances = new Map<
    FundingSourceId,
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
    const sourceId = allocationPartyId(row, directory);
    const balance = sourceId ? balances.get(sourceId) : undefined;
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
    const from = balances.get(transfer.fromSourceId);
    const to = balances.get(transfer.toSourceId);
    if (from) from.sent += cents;
    if (to) to.received += cents;
    if (!from || !to) {
      transferGaps.push({
        code: "unattributed_transfer_party",
        amount: money(cents),
        targetIds: [transfer.id],
      });
    }
    if (Number(transfer.evidenceCount) === 1) {
      transferGaps.push({
        code: "transfer_evidence_one_sided",
        amount: money(cents),
        targetIds: [transfer.id],
      });
    }
  }

  const parties = [...directory.parties.entries()]
    .map(([sourceId, party]) => {
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
    })
    .sort((a, b) => a.party.name.localeCompare(b.party.name));

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
    .map((row) => ({ code: "unpriced_expense", targetIds: [row.shortcode] }));
  const allGaps = [
    ...attributionGaps(allocations),
    ...accountGaps,
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
  const [directory, allocations, facts, peopleRows] = await Promise.all([
    loadPartyDirectory(db),
    loadExpenseAllocations(db, scope),
    loadExpenseFacts(db, scope),
    unwrapDb(db)
      .select({
        id: person.id,
        shortcode: person.shortcode,
        name: person.name,
        kind: person.kind,
      })
      .from(person)
      .where(notDeleted(person)),
  ]);

  const consumed = new Map<PersonId, bigint>();
  const initiallyFunded = new Map<FundingSourceId, bigint>();
  let unattributedInitialFunding = 0n;
  for (const row of allocations) {
    if (row.role === "beneficiary") {
      if (row.personId)
        consumed.set(
          row.personId,
          (consumed.get(row.personId) ?? 0n) + row.cents,
        );
    } else if (
      row.fundingSourceId &&
      directory.parties.has(row.fundingSourceId)
    ) {
      initiallyFunded.set(
        row.fundingSourceId,
        (initiallyFunded.get(row.fundingSourceId) ?? 0n) + row.cents,
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
      directory.parties.get(sourceId)?.household ? [cents] : [],
    ),
  );
  const guestInitialFunding = sum(
    [...initiallyFunded.entries()].flatMap(([sourceId, cents]) =>
      directory.parties.get(sourceId)?.household === false ? [cents] : [],
    ),
  );
  const gaps = [
    ...attributionGaps(allocations).map(
      (gap) => `${gap.code}: ${gap.targetIds.join(", ")}`,
    ),
    ...facts
      .filter((row) => row.costCents === null)
      .map((row) => `unpriced_expense: ${row.shortcode}`),
  ];

  return projectContributionOut.parse({
    projectId: input.projectId,
    wholeGroupCost: money(
      sum(
        facts.flatMap((row) =>
          row.costCents === null ? [] : [BigInt(row.costCents)],
        ),
      ),
    ),
    householdInitialExposure: money(householdInitialExposure),
    guestInitialFunding: money(guestInitialFunding),
    unattributedInitialFunding: money(unattributedInitialFunding),
    people: peopleRows
      .filter((row) => consumed.has(row.id))
      .map((row) => ({
        personId: row.shortcode,
        name: row.name,
        kind: row.kind,
        consumed: money(consumed.get(row.id) ?? 0n),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    funders,
    gaps,
  });
}
