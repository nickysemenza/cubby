import type { ActorContext } from "@cubby/schemas/context";
import type {
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import {
  type FinancialAccountCreateInput,
  type FinancialAccountFilters,
  type FinancialAccountOut,
  type FinancialAccountUpdateData,
  financialAccountIdentity,
  financialAccountOut,
  financialAccountSortableFields,
} from "@cubby/schemas/financial-account";
import {
  type FinancialAccountId,
  type FinancialAccountShortcode,
  unsafeFinancialAccountId,
  unsafeFinancialAccountShortcode,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { buildTakeSkip } from "@cubby/schemas/pagination";
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { financialAccount, financialTransaction } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  buildOrderBy,
  buildPartialUpdateValues,
  buildSearchConditions,
  countWhere,
  executeListQueryWithCount,
  getDb,
  lockAndValidateForDelete,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { lockFinancialEvidenceKeys } from "~/server/repo/financial-evidence";
import { countByTarget, impact, present } from "~/server/repo/impact";
import {
  resolveLiveShortcode,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

export const FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY = {
  "FinancialTransaction.accountId": {
    code: "block-live-financial-transactions",
    effect: "block",
    description:
      "An account cannot be deleted while live financial transactions still retain settlement evidence against it.",
  },
} as const satisfies IncomingEdgePolicy<
  "financialAccount",
  OperationDisposition
>;

const transactionCount = sql<number>`(
  SELECT count(*)::int FROM "FinancialTransaction" ft
  WHERE ft."accountId" = "FinancialAccount"."id" AND ft."deletedAt" IS NULL
)`;

const columns = {
  id: financialAccount.id,
  shortcode: financialAccount.shortcode,
  name: financialAccount.name,
  identity: financialAccount.identity,
  provisional: financialAccount.provisional,
  sourceAliases: financialAccount.sourceAliases,
  notes: financialAccount.notes,
  createdAt: financialAccount.createdAt,
  updatedAt: financialAccount.updatedAt,
  transactionCount,
} as const;

type FinancialAccountRow = Omit<
  typeof financialAccount.$inferSelect,
  "deletedAt"
> & {
  transactionCount: number;
};

const toOut = (row: FinancialAccountRow): FinancialAccountOut =>
  financialAccountOut.parse({
    id: unsafeFinancialAccountShortcode(row.shortcode),
    name: row.name,
    identity: financialAccountIdentity.parse(row.identity),
    provisional: row.provisional,
    sourceAliases: row.sourceAliases,
    notes: row.notes,
    transactionCount: Number(row.transactionCount),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const aliasCondition = (
  sources: string[] | undefined,
  externalAccountIds: string[] | undefined,
): SQL | undefined => {
  if (!sources && !externalAccountIds) return undefined;
  return sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof("FinancialAccount"."sourceAliases") = 'array'
      THEN "FinancialAccount"."sourceAliases" ELSE '[]'::jsonb END) alias
    WHERE ${sources ? sql`alias->>'source' = ANY(${sources})` : sql`TRUE`}
      AND ${externalAccountIds ? sql`alias->>'externalAccountId' = ANY(${externalAccountIds})` : sql`TRUE`}
  )`;
};

const whereFor = (filters: FinancialAccountFilters) =>
  buildSearchConditions(
    financialAccount,
    [{ column: financialAccount.name, term: filters.search }],
    [
      filters.identityKind
        ? sql`"FinancialAccount"."identity"->>'kind' = ANY(${[filters.identityKind].flat()})`
        : undefined,
      filters.provisional === undefined
        ? undefined
        : eq(financialAccount.provisional, filters.provisional),
      filters.last4
        ? sql`"FinancialAccount"."identity"->>'last4' = ${filters.last4}`
        : undefined,
      aliasCondition(
        filters.source ? [filters.source].flat() : undefined,
        filters.externalAccountId
          ? [filters.externalAccountId].flat()
          : undefined,
      ),
      filters.sourceAliasPresenceFilter === "has"
        ? sql`jsonb_array_length("FinancialAccount"."sourceAliases") > 0`
        : filters.sourceAliasPresenceFilter === "none"
          ? sql`jsonb_array_length("FinancialAccount"."sourceAliases") = 0`
          : undefined,
    ],
  );

export async function listFinancialAccounts(
  db: Database,
  filters: FinancialAccountFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: FinancialAccountOut[]; count: number }> {
  const where = whereFor(filters);
  const { take, skip } = buildTakeSkip(pagination);
  const { data: rows, count } = await executeListQueryWithCount(
    getDb(db)
      .select(columns)
      .from(financialAccount)
      .where(where)
      .orderBy(
        ...buildOrderBy(
          financialAccount,
          sorts,
          [...financialAccountSortableFields],
          {
            resolve: (sort) =>
              sort.orderBy === "transactionCount"
                ? [(sort.direction === "asc" ? asc : desc)(transactionCount)]
                : null,
          },
        ),
      )
      .limit(take)
      .offset(skip),
    countWhere(db, financialAccount, where),
  );
  return {
    data: rows.map(toOut),
    count,
  };
}

const financialAccountReader = createEntityReader<
  FinancialAccountRow,
  FinancialAccountOut,
  FinancialAccountId,
  Database | DrizzleTransaction
>({
  entity: "financialAccount",
  fetchById: async (db, id) => {
    const [row] = await unwrapDb(db)
      .select(columns)
      .from(financialAccount)
      .where(and(eq(financialAccount.id, id), notDeleted(financialAccount)))
      .limit(1);
    return row;
  },
  fromDB: (_db, row) => toOut(row),
  notFoundReason: "FINANCIAL_ACCOUNT_NOT_FOUND",
});

const getFinancialAccountByID = financialAccountReader.getByID;
export const getFinancialAccountByShortcode =
  financialAccountReader.getByShortcode;

async function assertAliasesAvailable(
  db: Database | DrizzleTransaction,
  aliases: FinancialAccountCreateInput["sourceAliases"],
  exceptId?: FinancialAccountId,
) {
  for (const alias of aliases) {
    if (!alias.externalAccountId) continue;
    const rows = await unwrapDb(db).execute<{ id: string }>(sql`
      SELECT fa.id::text AS id
      FROM "FinancialAccount" fa
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(fa."sourceAliases") = 'array' THEN fa."sourceAliases" ELSE '[]'::jsonb END) a
      WHERE fa."deletedAt" IS NULL
        AND a->>'source' = ${alias.source}
        AND a->>'externalAccountId' = ${alias.externalAccountId}
        ${exceptId ? sql`AND fa.id <> ${exceptId}` : sql``}
      LIMIT 1
    `);
    if (rows.rows[0]) {
      throw createAppError(
        "FINANCIAL_ACCOUNT_SOURCE_ALIAS_CONFLICT",
        `Source account ${alias.source}/${alias.externalAccountId} is already linked to another financial account.`,
      );
    }
  }
}

export async function createFinancialAccount(
  db: Database,
  data: FinancialAccountCreateInput,
  actor: ActorContext,
) {
  const id = await withTransaction(db, async (tx) => {
    await lockFinancialEvidenceKeys(
      tx,
      "account-alias",
      data.sourceAliases.flatMap((alias) =>
        alias.externalAccountId
          ? [`${alias.source}\0${alias.externalAccountId}`]
          : [],
      ),
    );
    await assertAliasesAvailable(tx, data.sourceAliases);
    const created = await insertWithShortcode(tx, "financialAccount", data);
    await logAuditEntry(tx, actor, {
      entityType: "financialAccount",
      entityId: created.id,
      action: "create",
    });
    return created.id;
  });
  return { output: await getFinancialAccountByID(db, id), entityId: id };
}

export async function updateFinancialAccount(
  db: Database,
  id: FinancialAccountShortcode,
  data: FinancialAccountUpdateData,
  actor: ActorContext,
) {
  const resolved = await resolveLiveShortcode(db, id, "financialAccount");
  if (!resolved)
    throw createAppError(
      "FINANCIAL_ACCOUNT_NOT_FOUND",
      `Financial account not found: ${id}`,
    );
  const accountId = unsafeFinancialAccountId(resolved);
  await withTransaction(db, async (tx) => {
    const before = await tx.query.financialAccount.findFirst({
      where: and(
        eq(financialAccount.id, accountId),
        notDeleted(financialAccount),
      ),
    });
    if (!before)
      throw createAppError(
        "FINANCIAL_ACCOUNT_NOT_FOUND",
        `Financial account not found: ${id}`,
      );
    if (data.sourceAliases !== undefined) {
      await lockFinancialEvidenceKeys(
        tx,
        "account-alias",
        data.sourceAliases.flatMap((alias) =>
          alias.externalAccountId
            ? [`${alias.source}\0${alias.externalAccountId}`]
            : [],
        ),
      );
      await assertAliasesAvailable(tx, data.sourceAliases, accountId);
    }
    const values = buildPartialUpdateValues(data);
    await tx
      .update(financialAccount)
      .set(values)
      .where(
        and(eq(financialAccount.id, accountId), notDeleted(financialAccount)),
      );
    const after = { ...before, ...values };
    const changes = computeChanges(before, after, [
      "name",
      "identity",
      "provisional",
      "sourceAliases",
      "notes",
    ]);
    if (changes)
      await logAuditEntry(tx, actor, {
        entityType: "financialAccount",
        entityId: accountId,
        action: "update",
        changes,
      });
  });
  return {
    output: await getFinancialAccountByID(db, accountId),
    entityId: accountId,
  };
}

export async function deleteFinancialAccounts(
  db: Database,
  shortcodes: FinancialAccountShortcode[],
  actor: ActorContext,
) {
  const resolved = await resolveLiveShortcodes(
    db,
    shortcodes,
    "financialAccount",
  );
  const ids = uniq(
    shortcodes.map((code) => {
      const id = resolved.get(code);
      if (!id)
        throw createAppError(
          "FINANCIAL_ACCOUNT_NOT_FOUND",
          `Financial account not found: ${code}`,
        );
      return unsafeFinancialAccountId(id);
    }),
  );
  await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(
      tx,
      financialAccount,
      ids,
      "FinancialAccount",
    );
    const [liveTransaction] = await tx
      .select({ id: financialTransaction.id })
      .from(financialTransaction)
      .where(
        and(
          inArray(financialTransaction.accountId, ids),
          notDeleted(financialTransaction),
        ),
      )
      .limit(1);
    if (liveTransaction)
      throw createAppError(
        "FINANCIAL_ACCOUNT_HAS_TRANSACTIONS",
        "Cannot delete a financial account while live transactions reference it.",
      );
    await tx
      .update(financialAccount)
      .set({ deletedAt: new Date() })
      .where(
        and(inArray(financialAccount.id, ids), notDeleted(financialAccount)),
      );
    await logAuditEntries(
      tx,
      actor,
      ids.map((entityId) => ({
        entityType: "financialAccount" as const,
        entityId,
        action: "delete" as const,
      })),
    );
  });
}

/** Advisory delete impact using the same live-transaction predicate as delete. */
export async function previewDeleteFinancialAccounts(
  db: Database,
  ids: FinancialAccountId[],
): Promise<{
  blockers: ImpactItem[];
  changes: ImpactItem[];
  sideEffects: ImpactItem[];
}> {
  if (ids.length === 0) return { blockers: [], changes: [], sideEffects: [] };
  const byTargetId = await countByTarget(
    getDb(db),
    financialTransaction,
    financialTransaction.accountId,
    ids,
  );
  return {
    blockers: present([
      impact({
        disposition:
          FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY[
            "FinancialTransaction.accountId"
          ],
        edgeKey: "FinancialTransaction.accountId",
        label: "live transactions still pointing at this account",
        byTargetId,
      }),
    ]),
    changes: [],
    sideEffects: [],
  };
}
