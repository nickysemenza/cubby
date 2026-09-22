import type { ActorContext } from "@cubby/schemas/context";
import type { DataQuality } from "@cubby/schemas/data-quality";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import {
  type PublicImpactItem,
  toPublicImpact,
} from "@cubby/schemas/entity-integrity";
import {
  type FinancialAccountCreateInput,
  type FinancialAccountFilters,
  type FinancialAccountOptionsOut,
  type FinancialAccountOut,
  type FinancialAccountUpdateData,
  financialAccountIdentity,
  financialAccountOut,
} from "@cubby/schemas/financial-account";
import {
  type FinancialAccountId,
  type FinancialAccountShortcode,
  parseEntityRef,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type { AppErrorReason } from "@cubby/shared";
import { and, asc, desc, eq, type SQL, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  financialAccount,
  financialTransaction,
  ledgerParty,
  statementRow,
} from "~/server/db/schema";
import { createAppError, createBlockedError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  auditDateWhereConditions,
  buildPartialUpdateValues,
  countWhere,
  executeListQueryWithCount,
  getDb,
  lockAndValidateForDelete,
  matchesStringValues,
  notDeleted,
  shortcodeSetCondition,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { lockFinancialEvidenceKeys } from "~/server/repo/financial-evidence";
import { countByTarget, impact } from "~/server/repo/impact";
import { lockLedgerPartiesForReference } from "~/server/repo/ledger-party-reference";
import { listScaffold } from "~/server/repo/list-scaffold";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { removeEntity } from "~/server/repo/removal";
import {
  lookupShortcodes,
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

export const FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY = {
  "FinancialTransaction.accountId": {
    code: "block-live-financial-transactions",
    effect: "block",
    description:
      "An account cannot be deleted while live financial transactions still retain settlement evidence against it.",
  },
  "StatementRow.accountId": {
    code: "block-live-statement-rows",
    effect: "block",
    description:
      "An account cannot be deleted while live statement rows are assigned to it. The column is nullable, so detaching would succeed silently — and it would discard the triage judgment that put the row on this account while leaving the row looking untriaged.",
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
  cardNumbers: financialAccount.cardNumbers,
  inventoryOwnerDefaultEnabled: financialAccount.inventoryOwnerDefaultEnabled,
  ledgerPartyShortcode: sql<
    string | null
  >`(SELECT shortcode FROM "LedgerParty" WHERE id = "FinancialAccount"."ledgerPartyId")`,
  ledgerPartyName: sql<
    string | null
  >`(SELECT name FROM "LedgerParty" WHERE id = "FinancialAccount"."ledgerPartyId")`,
  notes: financialAccount.notes,
  createdAt: financialAccount.createdAt,
  updatedAt: financialAccount.updatedAt,
  transactionCount,
} as const;

type FinancialAccountRow = Omit<
  typeof financialAccount.$inferSelect,
  "ledgerPartyId" | "deletedAt"
> & {
  transactionCount: number;
  ledgerPartyShortcode: string | null;
  ledgerPartyName: string | null;
};

const toOut = (
  row: FinancialAccountRow,
  dataQuality: DataQuality,
): FinancialAccountOut =>
  financialAccountOut.parse({
    id: parseShortcodeFor("financialAccount", row.shortcode),
    name: row.name,
    identity: financialAccountIdentity.parse(row.identity),
    provisional: row.provisional,
    sourceAliases: row.sourceAliases,
    cardNumbers: row.cardNumbers,
    inventoryOwnerDefaultEnabled: row.inventoryOwnerDefaultEnabled,
    ledgerPartyId: row.ledgerPartyShortcode
      ? parseShortcodeFor("ledgerParty", row.ledgerPartyShortcode)
      : null,
    ledgerPartyName: row.ledgerPartyName,
    notes: row.notes,
    transactionCount: Number(row.transactionCount),
    dataQuality,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

/**
 * The account picklist. Ordered by transaction count so the cards actually used
 * for settlement sort to the top, then by name — the same ordering `vendorOptions`
 * uses, and for the same reason: a roster is scanned, not searched.
 *
 * Lists accounts with no transactions too. A provisional account minted by a
 * statement import before any row is linked is exactly the one you want to be
 * able to filter for.
 */
export const financialAccountOptions = async (
  db: Database,
): Promise<FinancialAccountOptionsOut> => {
  const rows = await getDb(db)
    .select({
      shortcode: financialAccount.shortcode,
      name: financialAccount.name,
      count: transactionCount,
    })
    .from(financialAccount)
    .where(notDeleted(financialAccount))
    .orderBy(desc(transactionCount), asc(financialAccount.name));

  return rows.map((row) => ({
    id: parseShortcodeFor("financialAccount", row.shortcode),
    name: row.name,
    count: Number(row.count),
  }));
};

const aliasCondition = (
  sources: string[] | undefined,
  externalAccountIds: string[] | undefined,
): SQL | undefined => {
  if (!sources && !externalAccountIds) return undefined;
  return sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof("FinancialAccount"."sourceAliases") = 'array'
      THEN "FinancialAccount"."sourceAliases" ELSE '[]'::jsonb END) alias
    WHERE ${matchesStringValues(sql`alias->>'source'`, sources)}
      AND ${matchesStringValues(sql`alias->>'externalAccountId'`, externalAccountIds)}
  )`;
};

const financialAccountScaffold = listScaffold(
  "financialAccount",
  financialAccount,
);

/** The complete WHERE for this entity's list. `getEntityCounts` calls it with `{}` — see repo/dashboard.ts. */
export const buildFinancialAccountWhere = (filters: FinancialAccountFilters) =>
  // `name` (text) and `provisional` (boolean) are declared stored filters —
  // applied by `.where` before the conditions below.
  financialAccountScaffold.where(filters, [
    ...auditDateWhereConditions(financialAccount, filters),
    ...relatedWhereConditions("financialAccount", filters, financialAccount.id),
    shortcodeSetCondition(
      sql`(SELECT lp."shortcode" FROM "LedgerParty" lp WHERE lp."id" = "FinancialAccount"."ledgerPartyId")`,
      filters.ledgerPartyId,
    ),
    // `matchesStringValues`, NOT sql`expr = ANY(${arr})`: drizzle expands a
    // JS array in a template into a row constructor (`ANY(($1, $2))`), which
    // postgres rejects.
    filters.identityKind
      ? matchesStringValues(
          sql`"FinancialAccount"."identity"->>'kind'`,
          [filters.identityKind].flat(),
        )
      : undefined,
    // Any card the account has ever presented, not just today's primary:
    // a receipt's digits are the usual reason someone filters by last four.
    filters.last4
      ? sql`EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE
            WHEN jsonb_typeof("FinancialAccount"."cardNumbers") = 'array'
            THEN "FinancialAccount"."cardNumbers" ELSE '[]'::jsonb END) card
          WHERE card->>'last4' = ${filters.last4}
        )`
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
  ]);

export async function listFinancialAccounts(
  db: Database,
  filters: FinancialAccountFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: FinancialAccountOut[]; count: number }> {
  const where = buildFinancialAccountWhere(filters);
  const { take, skip } = financialAccountScaffold.page(pagination);
  const { data: rows, count } = await executeListQueryWithCount(
    getDb(db)
      .select(columns)
      .from(financialAccount)
      .where(where)
      .orderBy(
        ...financialAccountScaffold.orderBy(
          sorts,
          {
            resolve: (sort) =>
              sort.orderBy === "transactionCount"
                ? [(sort.direction === "asc" ? asc : desc)(transactionCount)]
                : null,
          },
          filters,
        ),
      )
      .limit(take)
      .offset(skip),
    countWhere(db, financialAccount, where),
  );
  const dataQualities = await loadDataQualities(
    db,
    "financialAccount",
    rows.map((row) => row.id),
  );
  return {
    // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
    data: rows.map((row) => toOut(row, dataQualities.get(row.id)!)),
    count,
  };
}

const financialAccountReader = createEntityReader<
  FinancialAccountRow,
  FinancialAccountOut,
  "financialAccount",
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
  fromDB: async (db, row) => {
    const dataQualities = await loadDataQualities(db, "financialAccount", [
      row.id,
    ]);
    // SAFETY: `row` was just fetched live by id, so its quality was evaluated.
    return toOut(row, dataQualities.get(row.id)!);
  },
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

async function resolveLedgerPartyForAccount(
  tx: DrizzleTransaction,
  shortcode: FinancialAccountCreateInput["ledgerPartyId"],
) {
  if (shortcode === null) return null;
  const [party] = await lockLedgerPartiesForReference(tx, [shortcode]);
  if (!party || party.kind === "guest")
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A financial account may map only to a member or the household ledger party.",
    );
  return party.id;
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
    const { ledgerPartyId, ...columns } = data;
    const resolvedLedgerPartyId = await resolveLedgerPartyForAccount(
      tx,
      ledgerPartyId,
    );
    if (data.inventoryOwnerDefaultEnabled) {
      if (!resolvedLedgerPartyId) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "An inventory owner default requires an individual account owner.",
        );
      }
      const party = await tx.query.ledgerParty.findFirst({
        where: eq(ledgerParty.id, resolvedLedgerPartyId),
        columns: { kind: true },
      });
      if (party?.kind !== "member") {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "An inventory owner default requires an individual account owner.",
        );
      }
    }
    const created = await insertWithShortcode(tx, "financialAccount", {
      ...columns,
      ledgerPartyId: resolvedLedgerPartyId,
    });
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
  const accountId = await resolveOrThrow(db, "financialAccount", id);
  await withTransaction(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(financialAccount)
      .where(
        and(eq(financialAccount.id, accountId), notDeleted(financialAccount)),
      )
      .for("update")
      .limit(1);
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
    const ledgerPartyId =
      data.ledgerPartyId === undefined
        ? undefined
        : await resolveLedgerPartyForAccount(tx, data.ledgerPartyId);
    const inventoryOwnerDefaultEnabled =
      data.inventoryOwnerDefaultEnabled ?? before.inventoryOwnerDefaultEnabled;
    if (inventoryOwnerDefaultEnabled) {
      const effectivePartyId =
        ledgerPartyId === undefined ? before.ledgerPartyId : ledgerPartyId;
      const party = effectivePartyId
        ? await tx.query.ledgerParty.findFirst({
            where: and(
              eq(ledgerParty.id, effectivePartyId),
              notDeleted(ledgerParty),
            ),
            columns: { kind: true },
          })
        : null;
      if (party?.kind !== "member") {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "An inventory owner default requires an individual account owner.",
        );
      }
    }
    if (ledgerPartyId !== undefined && ledgerPartyId !== before.ledgerPartyId) {
      const [linkedEvidence] = await tx
        .select({ id: financialTransaction.id })
        .from(financialTransaction)
        .where(
          and(
            eq(financialTransaction.accountId, accountId),
            sql`${financialTransaction.ledgerTransferId} IS NOT NULL`,
            notDeleted(financialTransaction),
          ),
        )
        .limit(1);
      if (linkedEvidence)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Cannot change an account's ledger party while it evidences a ledger transfer.",
        );
    }
    const { ledgerPartyId: _ledgerPartyId, ...accountData } = data;
    const updateData: Partial<typeof financialAccount.$inferInsert> = {
      ...accountData,
    };
    if (ledgerPartyId !== undefined) updateData.ledgerPartyId = ledgerPartyId;
    const values = buildPartialUpdateValues(updateData);
    await tx
      .update(financialAccount)
      .set(values)
      .where(
        and(eq(financialAccount.id, accountId), notDeleted(financialAccount)),
      );
    const after = { ...before, ...values };
    const changes = computeChanges(before, after, [
      ...entityFieldModels.financialAccount.audit,
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
): Promise<{ deleted: number }> {
  const ids = uniq(await resolveAllOrThrow(db, "financialAccount", shortcodes));
  return await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(
      tx,
      financialAccount,
      ids,
      "FinancialAccount",
    );
    // `countByTarget` rather than a `.limit(1)` existence probe: the probe knew
    // only THAT something blocked, so the refusal could not name which account
    // or how many rows. It is also the same call the preview makes, so the two
    // can no longer disagree about what blocks.
    const [transactionsByTarget, statementRowsByTarget] = [
      await countByTarget(
        tx,
        financialTransaction,
        financialTransaction.accountId,
        ids,
      ),
      // `StatementRow.accountId` has been declared `effect: "block"` in
      // FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY all along with nothing enforcing
      // it — neither this guard nor the preview queried the table.
      await countByTarget(tx, statementRow, statementRow.accountId, ids),
    ];
    await assertNoBlockingCounts(
      tx,
      transactionsByTarget,
      "FINANCIAL_ACCOUNT_HAS_TRANSACTIONS",
      "live transactions",
      "FinancialTransaction.accountId",
      FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY["FinancialTransaction.accountId"],
    );
    await assertNoBlockingCounts(
      tx,
      statementRowsByTarget,
      "FINANCIAL_ACCOUNT_HAS_STATEMENT_ROWS",
      "live statement rows",
      "StatementRow.accountId",
      FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY["StatementRow.accountId"],
    );
    const { deleted } = await removeEntity(tx, {
      entity: "financialAccount",
      ids,
      removal: "soft",
      actor,
    });
    return { deleted };
  });
}

/**
 * Refuse when any target still has dependents, naming the targets and their
 * counts. `countByTarget` keys by account id, so the message can say WHICH
 * account blocked and with how many rows — the thing the old existence probe
 * threw away.
 */
async function assertNoBlockingCounts(
  db: Database | DrizzleTransaction,
  byTargetId: Record<string, number>,
  reason: AppErrorReason,
  noun: string,
  edgeKey: string,
  disposition: OperationDisposition,
): Promise<void> {
  const blocked = Object.entries(byTargetId).filter(([, n]) => n > 0);
  if (blocked.length === 0) return;

  // The blockers travel as DATA, not only as prose. `byTargetId` is uuid-keyed
  // inside a repo, so it is translated to shortcodes before leaving — a uuid
  // must never cross the API boundary, and `toPublicImpact("throw")` makes an
  // unmappable target loud rather than silently dropping a blocker.
  const publicIdByEntityId = await lookupShortcodes(
    db,
    blocked.map(([id]) => parseEntityRef("financialAccount", id)),
  );
  const item = impact({
    disposition,
    edgeKey,
    label: noun,
    byTargetId: Object.fromEntries(blocked),
  });
  // Translation failure must never replace the refusal. This is an ERROR path:
  // the caller's problem is that the delete is blocked, and swapping a typed
  // `FINANCIAL_ACCOUNT_HAS_TRANSACTIONS` for a raw "no public id for target"
  // would hide the real answer behind a bookkeeping detail. So the structured
  // blockers are best-effort here even though `"throw"` is the right policy for
  // a SUCCESS payload, where a dropped id would silently under-report.
  let blockers: PublicImpactItem[] = [];
  if (item) {
    try {
      blockers = [toPublicImpact(item, publicIdByEntityId, "throw")];
    } catch {
      // SILENT: see the comment above — the typed `createBlockedError` thrown
      // below is the refusal itself; losing the structured `blockers[]`
      // extra must not replace it with a bookkeeping-detail error instead.
      blockers = [];
    }
  }

  const detail = blocked
    .map(([id, n]) => `${publicIdByEntityId.get(id) ?? id} (${n})`)
    .join(", ");
  throw createBlockedError(
    reason,
    `Cannot delete a financial account while ${noun} reference it: ${detail}.`,
    blockers,
  );
}
