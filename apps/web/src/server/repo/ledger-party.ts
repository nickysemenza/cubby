import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type {
  LedgerPartyId,
  LedgerPartyShortcode,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  LedgerPartyCreateInput,
  LedgerPartyFilters,
  LedgerPartyKind,
  LedgerPartyOut,
  LedgerPartyUpdateData,
} from "@cubby/schemas/ledger-party";
import { ledgerPartyOut } from "@cubby/schemas/ledger-party";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { buildTakeSkip } from "@cubby/schemas/pagination";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  expenseAttribution,
  financialAccount,
  ledgerParty,
  ledgerTransfer,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  auditDateWhereConditions,
  buildPartialUpdateValues,
  countWhere,
  executeListQueryWithCount,
  getDb,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { countByTarget, impact, present } from "~/server/repo/impact";
import {
  assertDistinctMergeTargets,
  finalizeMerge,
  resolveMergeTargets,
} from "~/server/repo/merge/core";
import { removeEntity } from "~/server/repo/removal/entity";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

export const LEDGER_PARTY_DELETE_EDGE_POLICY = {
  "ExpenseAttribution.ledgerPartyId": {
    code: "block-attributions",
    effect: "block",
    description: "Live expense shares retain their party.",
  },
  "FinancialAccount.ledgerPartyId": {
    code: "block-accounts",
    effect: "block",
    description: "Live accounts retain their ledger party.",
  },
  "LedgerTransfer.fromPartyId": {
    code: "block-outgoing-transfers",
    effect: "block",
    description: "Live transfers retain their source party.",
  },
  "LedgerTransfer.toPartyId": {
    code: "block-incoming-transfers",
    effect: "block",
    description: "Live transfers retain their target party.",
  },
} as const satisfies IncomingEdgePolicy<"ledgerParty", OperationDisposition>;

export const LEDGER_PARTY_MERGE_EDGE_POLICY = {
  "ExpenseAttribution.ledgerPartyId": {
    code: "merge-attributions",
    effect: "move-dedupe",
    description: "Colliding weighted shares are summed.",
  },
  "FinancialAccount.ledgerPartyId": {
    code: "repoint-accounts",
    effect: "repoint",
    description: "Accounts move to the surviving party.",
  },
  "LedgerTransfer.fromPartyId": {
    code: "repoint-outgoing-transfers",
    effect: "repoint",
    description: "Transfer source endpoints move to the survivor.",
  },
  "LedgerTransfer.toPartyId": {
    code: "repoint-incoming-transfers",
    effect: "repoint",
    description: "Transfer target endpoints move to the survivor.",
  },
} as const satisfies IncomingEdgePolicy<"ledgerParty", OperationDisposition>;

const columns = {
  id: ledgerParty.id,
  shortcode: ledgerParty.shortcode,
  name: ledgerParty.name,
  kind: ledgerParty.kind,
  notes: ledgerParty.notes,
  createdAt: ledgerParty.createdAt,
  updatedAt: ledgerParty.updatedAt,
} as const;

type LedgerPartyRow = {
  id: LedgerPartyId;
  shortcode: string;
  name: string;
  kind: LedgerPartyKind;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const toOut = (row: LedgerPartyRow): LedgerPartyOut =>
  ledgerPartyOut.parse({
    id: parseShortcodeFor("ledgerParty", row.shortcode),
    name: row.name,
    kind: row.kind,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const getById = async (
  db: Database | DrizzleTransaction,
  id: LedgerPartyId,
): Promise<LedgerPartyRow | undefined> => {
  const [row] = await unwrapDb(db)
    .select(columns)
    .from(ledgerParty)
    .where(and(eq(ledgerParty.id, id), notDeleted(ledgerParty)))
    .limit(1);
  return row;
};

const reader = createEntityReader<
  LedgerPartyRow,
  LedgerPartyOut,
  "ledgerParty"
>({
  entity: "ledgerParty",
  fetchById: getById,
  fromDB: (_db, row) => toOut(row),
});

export const getLedgerPartyByShortcode = reader.getByShortcode;

export async function listLedgerParties(
  db: Database,
  filters: LedgerPartyFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) {
  const where = and(
    notDeleted(ledgerParty),
    ...auditDateWhereConditions(ledgerParty, filters),
    filters.search
      ? ilike(ledgerParty.name, `%${filters.search.trim()}%`)
      : undefined,
    filters.kind
      ? inArray(ledgerParty.kind, filters.kind as LedgerPartyKind[])
      : undefined,
  );
  const order = sorts[0] ?? { orderBy: "name", direction: "asc" as const };
  const orderColumn =
    {
      name: ledgerParty.name,
      kind: ledgerParty.kind,
      createdAt: ledgerParty.createdAt,
      updatedAt: ledgerParty.updatedAt,
    }[order.orderBy as "name"] ?? ledgerParty.name;
  const { take, skip } = buildTakeSkip(pagination);
  const { data, count } = await executeListQueryWithCount(
    getDb(db)
      .select(columns)
      .from(ledgerParty)
      .where(where)
      .orderBy(
        order.direction === "desc" ? desc(orderColumn) : asc(orderColumn),
      )
      .limit(take)
      .offset(skip),
    countWhere(db, ledgerParty, where),
  );
  return { data: data.map(toOut), count };
}

export async function createLedgerParty(
  db: Database,
  data: LedgerPartyCreateInput,
  actor: ActorContext,
) {
  const id = await withTransaction(db, async (tx) => {
    if (data.kind === "household") {
      const [existing] = await tx
        .select({ id: ledgerParty.id })
        .from(ledgerParty)
        .where(and(eq(ledgerParty.kind, "household"), notDeleted(ledgerParty)))
        .limit(1);
      if (existing)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Only one household ledger party may exist.",
        );
    }
    const created = await insertWithShortcode(tx, "ledgerParty", data);
    await logAuditEntry(tx, actor, {
      entityType: "ledgerParty",
      entityId: created.id,
      action: "create",
    });
    return created.id;
  });
  return { output: await reader.getByID(db, id), entityId: id };
}

export async function updateLedgerParty(
  db: Database,
  shortcode: LedgerPartyShortcode,
  data: LedgerPartyUpdateData,
  actor: ActorContext,
) {
  const id = await resolveOrThrow(db, "ledgerParty", shortcode);
  await withTransaction(db, async (tx) => {
    const [before] = await tx
      .select(columns)
      .from(ledgerParty)
      .where(and(eq(ledgerParty.id, id), notDeleted(ledgerParty)))
      .for("update")
      .limit(1);
    if (!before)
      throw createAppError(
        "LEDGER_PARTY_NOT_FOUND",
        `Ledger party not found: ${shortcode}`,
      );
    if (
      data.kind !== undefined &&
      (before.kind === "household" || data.kind === "household") &&
      data.kind !== before.kind
    ) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "The singleton household ledger party cannot change kind.",
      );
    }
    if (before.kind !== "guest" && data.kind === "guest") {
      const [mappedAccount] = await tx
        .select({ id: financialAccount.id })
        .from(financialAccount)
        .where(
          and(
            eq(financialAccount.ledgerPartyId, id),
            notDeleted(financialAccount),
          ),
        )
        .limit(1);
      if (mappedAccount)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "A ledger party mapped by a live financial account cannot become a guest.",
        );
    }
    const values = buildPartialUpdateValues(data);
    await tx
      .update(ledgerParty)
      .set(values)
      .where(and(eq(ledgerParty.id, id), notDeleted(ledgerParty)));
    const changes = computeChanges(before, { ...before, ...values }, [
      "name",
      "kind",
      "notes",
    ]);
    if (changes)
      await logAuditEntry(tx, actor, {
        entityType: "ledgerParty",
        entityId: id,
        action: "update",
        changes,
      });
  });
  return { output: await reader.getByID(db, id), entityId: id };
}

export async function deleteLedgerParties(
  db: Database,
  shortcodes: LedgerPartyShortcode[],
  actor: ActorContext,
) {
  const ids = uniq(
    await Promise.all(
      shortcodes.map((id) => resolveOrThrow(db, "ledgerParty", id)),
    ),
  );
  return withTransaction(db, async (tx) => {
    const parties = await tx
      .select(columns)
      .from(ledgerParty)
      .where(and(inArray(ledgerParty.id, ids), notDeleted(ledgerParty)))
      .for("update");
    if (parties.length !== ids.length)
      throw createAppError(
        "LEDGER_PARTY_NOT_FOUND",
        "A ledger party selected for deletion is no longer live.",
      );
    if (parties.some((party) => party.kind === "household"))
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "The singleton household ledger party cannot be deleted.",
      );
    const [refs] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(expenseAttribution)
      .where(
        and(
          inArray(expenseAttribution.ledgerPartyId, ids),
          notDeleted(expenseAttribution),
        ),
      );
    const [accounts] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(financialAccount)
      .where(
        and(
          inArray(financialAccount.ledgerPartyId, ids),
          notDeleted(financialAccount),
        ),
      );
    const [transfers] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(ledgerTransfer)
      .where(
        and(
          or(
            inArray(ledgerTransfer.fromPartyId, ids),
            inArray(ledgerTransfer.toPartyId, ids),
          ),
          notDeleted(ledgerTransfer),
        ),
      );
    if ((refs?.n ?? 0) + (accounts?.n ?? 0) + (transfers?.n ?? 0) > 0)
      throw createAppError(
        "LEDGER_PARTY_HAS_EDGES",
        "A ledger party with live attributions, accounts, or transfers cannot be deleted.",
      );
    const { deleted } = await removeEntity(tx, {
      entity: "ledgerParty",
      ids,
      removal: "soft",
      actor,
    });
    return { deleted };
  });
}

export async function previewMergeLedgerParties(
  db: Database,
  input: { keepId: LedgerPartyId; mergeIds: LedgerPartyId[] },
) {
  assertDistinctMergeTargets("ledgerParty", input.keepId, input.mergeIds);
  const mergeIds = uniq(input.mergeIds);
  const allIds = [input.keepId, ...mergeIds];
  const [parties, attributions, accounts, outgoing, incoming] =
    await Promise.all([
      unwrapDb(db)
        .select(columns)
        .from(ledgerParty)
        .where(and(inArray(ledgerParty.id, allIds), notDeleted(ledgerParty))),
      countByTarget(
        getDb(db),
        expenseAttribution,
        expenseAttribution.ledgerPartyId,
        allIds,
      ),
      countByTarget(
        getDb(db),
        financialAccount,
        financialAccount.ledgerPartyId,
        mergeIds,
      ),
      countByTarget(
        getDb(db),
        ledgerTransfer,
        ledgerTransfer.fromPartyId,
        mergeIds,
      ),
      countByTarget(
        getDb(db),
        ledgerTransfer,
        ledgerTransfer.toPartyId,
        mergeIds,
      ),
    ]);
  const invalid =
    parties.length !== mergeIds.length + 1 ||
    parties.some((party) => party.kind === "household") ||
    new Set(parties.map((party) => party.kind)).size !== 1;
  return {
    blockers: invalid
      ? [
          {
            code: "invalid-party-merge",
            effect: "block" as const,
            label: "incompatible ledger parties",
            description:
              "Only live parties of one non-household kind can be merged.",
            total: 1,
            byTargetId: { [input.keepId]: 1 },
          },
        ]
      : [],
    changes: present([
      impact({
        disposition:
          LEDGER_PARTY_MERGE_EDGE_POLICY["ExpenseAttribution.ledgerPartyId"],
        edgeKey: "ExpenseAttribution.ledgerPartyId",
        label: "expense attributions",
        byTargetId: attributions,
      }),
      impact({
        disposition:
          LEDGER_PARTY_MERGE_EDGE_POLICY["FinancialAccount.ledgerPartyId"],
        edgeKey: "FinancialAccount.ledgerPartyId",
        label: "financial accounts",
        byTargetId: accounts,
      }),
      impact({
        disposition:
          LEDGER_PARTY_MERGE_EDGE_POLICY["LedgerTransfer.fromPartyId"],
        edgeKey: "LedgerTransfer.fromPartyId",
        label: "outgoing transfers",
        byTargetId: outgoing,
      }),
      impact({
        disposition: LEDGER_PARTY_MERGE_EDGE_POLICY["LedgerTransfer.toPartyId"],
        edgeKey: "LedgerTransfer.toPartyId",
        label: "incoming transfers",
        byTargetId: incoming,
      }),
    ]),
    sideEffects: [],
  };
}

export async function mergeLedgerParties(
  db: Database,
  input: { keepId: LedgerPartyShortcode; mergeIds: LedgerPartyShortcode[] },
  actor: ActorContext,
) {
  const { keepId, loserIds } = await resolveMergeTargets(db, {
    entity: "ledgerParty",
    ...input,
  });
  let merged = 0;
  let attributionEdgesRepointed = 0;
  let accountEdgesRepointed = 0;
  let transferEdgesRepointed = 0;
  await withTransaction(db, async (tx) => {
    const parties = await tx
      .select(columns)
      .from(ledgerParty)
      .where(
        and(
          inArray(ledgerParty.id, [keepId, ...loserIds]),
          notDeleted(ledgerParty),
        ),
      )
      .for("update");
    if (
      parties.length !== loserIds.length + 1 ||
      parties.some((party) => party.kind === "household") ||
      new Set(parties.map((party) => party.kind)).size !== 1
    )
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Only ledger parties of one non-household kind can be merged.",
      );
    const shares = await tx
      .select({
        expenseId: expenseAttribution.expenseId,
        role: expenseAttribution.role,
        weight: expenseAttribution.weight,
      })
      .from(expenseAttribution)
      .where(
        and(
          inArray(expenseAttribution.ledgerPartyId, [keepId, ...loserIds]),
          notDeleted(expenseAttribution),
        ),
      );
    const sharesByExpenseRole = new Map<string, typeof shares>();
    for (const share of shares) {
      const key = `${share.expenseId}:${share.role}`;
      sharesByExpenseRole.set(key, [
        ...(sharesByExpenseRole.get(key) ?? []),
        share,
      ]);
    }
    for (const group of sharesByExpenseRole.values()) {
      const foldedWeight = group.reduce(
        (total, share) => total + share.weight,
        0,
      );
      if (!Number.isSafeInteger(foldedWeight))
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Merged attribution weights exceed the safe integer range.",
        );
    }
    await tx
      .update(expenseAttribution)
      .set({ deletedAt: new Date() })
      .where(
        and(
          inArray(expenseAttribution.ledgerPartyId, [keepId, ...loserIds]),
          notDeleted(expenseAttribution),
        ),
      );
    for (const [_key, group] of sharesByExpenseRole) {
      const first = group[0]!;
      await tx.insert(expenseAttribution).values({
        expenseId: first.expenseId,
        role: first.role,
        ledgerPartyId: keepId,
        weight: group.reduce((total, share) => total + share.weight, 0),
      });
    }
    attributionEdgesRepointed = shares.length;
    const [accountCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(financialAccount)
      .where(
        and(
          inArray(financialAccount.ledgerPartyId, loserIds),
          notDeleted(financialAccount),
        ),
      );
    accountEdgesRepointed = accountCount?.n ?? 0;
    const [transferCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(ledgerTransfer)
      .where(
        and(
          or(
            inArray(ledgerTransfer.fromPartyId, loserIds),
            inArray(ledgerTransfer.toPartyId, loserIds),
          ),
          notDeleted(ledgerTransfer),
        ),
      );
    transferEdgesRepointed = transferCount?.n ?? 0;
    await tx
      .update(financialAccount)
      .set({ ledgerPartyId: keepId })
      .where(
        and(
          inArray(financialAccount.ledgerPartyId, loserIds),
          notDeleted(financialAccount),
        ),
      );
    await tx
      .update(ledgerTransfer)
      .set({ fromPartyId: keepId })
      .where(
        and(
          inArray(ledgerTransfer.fromPartyId, loserIds),
          notDeleted(ledgerTransfer),
        ),
      );
    await tx
      .update(ledgerTransfer)
      .set({ toPartyId: keepId })
      .where(
        and(
          inArray(ledgerTransfer.toPartyId, loserIds),
          notDeleted(ledgerTransfer),
        ),
      );
    merged = (
      await finalizeMerge(tx, {
        entity: "ledgerParty",
        table: ledgerParty,
        keepId,
        loserIds,
        removal: "soft",
        actor,
        survivorChanges: { mergedFrom: { from: null, to: loserIds } },
      })
    ).removed;
  });
  return {
    mergeSummary: {
      deletedIds: uniq(input.mergeIds),
      merged,
      attributionEdgesRepointed,
      accountEdgesRepointed,
      transferEdgesRepointed,
      carriedFields: [],
    },
  };
}
