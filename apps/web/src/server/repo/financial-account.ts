import type { ActorContext } from "@cubby/schemas/context";
import type { DataQuality } from "@cubby/schemas/data-quality";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import {
  type FinancialAccountCreateInput,
  type FinancialAccountFilters,
  type FinancialAccountOut,
  type FinancialAccountUpdateData,
  financialAccountIdentity,
  financialAccountOut,
} from "@cubby/schemas/financial-account";
import {
  type FinancialAccountId,
  type FinancialAccountShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { and, asc, desc, eq, type SQL, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  financialAccount,
  financialTransaction,
  ledgerParty,
  vendor,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality/hydrate";
import {
  buildPartialUpdateValues,
  matchesStringValues,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { lockFinancialEvidenceKeys } from "~/server/repo/financial-evidence";
import { lockLedgerPartiesForReference } from "~/server/repo/ledger-party-reference";
import { listScaffold } from "~/server/repo/list";
import {
  listGroupFields,
  hydrateListRead,
  type ListProjection,
} from "~/server/repo/list-projection";
import {
  asActor,
  defineRepository,
  listOn,
  listReadOn,
  onDb,
} from "~/server/repo/repository";
import { createEntityCrud } from "~/server/repo/repository";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { completeListReader } from "./list-read-adapters";

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

export const financialAccountTransactionCount = sql<number>`(
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
  providerVendorShortcode: sql<
    string | null
  >`(SELECT shortcode FROM "Vendor" WHERE id = "FinancialAccount"."providerVendorId")`,
  providerVendorName: sql<
    string | null
  >`(SELECT name FROM "Vendor" WHERE id = "FinancialAccount"."providerVendorId")`,
  notes: financialAccount.notes,
  createdAt: financialAccount.createdAt,
  updatedAt: financialAccount.updatedAt,
  transactionCount: financialAccountTransactionCount,
} as const;

const selectAccounts = (db: Database | DrizzleTransaction) =>
  unwrapDb(db).select(columns).from(financialAccount);
type FinancialAccountRow = Awaited<ReturnType<typeof selectAccounts>>[number];

const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: FinancialAccountRow[],
): Promise<FinancialAccountOut[]> => {
  const dataQualities = await loadDataQualities(
    db,
    "financialAccount",
    rows.map((row) => row.id),
  );
  // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
  return rows.map((row) => toOut(row, dataQualities.get(row.id)!));
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
    providerVendorId: row.providerVendorShortcode
      ? parseShortcodeFor("vendor", row.providerVendorShortcode)
      : null,
    providerVendorName: row.providerVendorName,
    notes: row.notes,
    transactionCount: Number(row.transactionCount),
    dataQuality,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const selectAccountsRead = (
  db: Database | DrizzleTransaction,
  projection: ListProjection,
) => {
  const {
    ledgerPartyShortcode,
    ledgerPartyName,
    providerVendorShortcode,
    providerVendorName,
    transactionCount,
    ...core
  } = columns;
  return unwrapDb(db)
    .select({
      ...core,
      ...listGroupFields(projection, "relations", () => ({
        ledgerPartyShortcode,
        ledgerPartyName,
        providerVendorShortcode,
        providerVendorName,
      })),
      ...listGroupFields(projection, "derived", () => ({ transactionCount })),
    })
    .from(financialAccount);
};
const hydrateAccountsRead = async (
  db: Database,
  rows: Awaited<ReturnType<typeof selectAccountsRead>>,
  projection: ListProjection,
) =>
  hydrateListRead(db, "financialAccount", rows, projection, {
    load: async () => undefined,
    mapRow: (row) => ({
      ...row,
      id: parseShortcodeFor("financialAccount", row.shortcode),
      ...listGroupFields(projection, "relations", () => ({
        ledgerPartyId: row.ledgerPartyShortcode
          ? parseShortcodeFor("ledgerParty", row.ledgerPartyShortcode)
          : null,
        providerVendorId: row.providerVendorShortcode
          ? parseShortcodeFor("vendor", row.providerVendorShortcode)
          : null,
      })),
    }),
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

export const listFinancialAccountsRead = (
  db: Database,
  filters: FinancialAccountFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
) =>
  financialAccountScaffold.list(
    db,
    { filters, sorts, pagination, projection },
    {
      where: buildFinancialAccountWhere(filters),
      resolveSort: (sort) =>
        sort.orderBy === "transactionCount"
          ? [
              (sort.direction === "asc" ? asc : desc)(
                financialAccountTransactionCount,
              ),
            ]
          : null,
      select: (page) =>
        selectAccountsRead(db, projection)
          .where(page.where)
          .orderBy(...page.orderBy)
          .limit(page.limit)
          .offset(page.offset),
      hydrate: (rows) => hydrateAccountsRead(db, rows, projection),
    },
  );

export const listFinancialAccounts = completeListReader(
  financialAccountOut,
  listFinancialAccountsRead,
);

/**
 * The audited-update unit: `update` runs the before-state read, column UPDATE,
 * diff audit and re-read in one transaction. Its row carries the raw
 * `ledgerPartyId` / `providerVendorId` beside the list columns so the audit
 * diffs the reference columns, not only their display shortcodes.
 */
const financialAccountCrud = createEntityCrud({
  table: financialAccount,
  entity: "financialAccount",
  fetchById: async (db, id) => {
    const [row] = await unwrapDb(db)
      .select({
        ...columns,
        ledgerPartyId: financialAccount.ledgerPartyId,
        providerVendorId: financialAccount.providerVendorId,
      })
      .from(financialAccount)
      .where(and(eq(financialAccount.id, id), notDeleted(financialAccount)))
      .limit(1);
    return row;
  },
  fromDB: async (db, row) => (await hydrate(db, [row]))[0]!,
  toUpdate: (data: Partial<typeof financialAccount.$inferInsert>) =>
    buildPartialUpdateValues(data),
  auditUpdateFields: [...entityFieldModels.financialAccount.audit],
});

const getFinancialAccountByID = financialAccountCrud.getByID;
const getFinancialAccountByShortcode = financialAccountCrud.getByShortcode;

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

async function resolveProviderVendorForAccount(
  tx: DrizzleTransaction,
  shortcode: FinancialAccountCreateInput["providerVendorId"],
) {
  if (shortcode === null) return null;
  const id = await resolveOrThrow(tx, "vendor", shortcode);
  // Row lock so a concurrent vendor delete cannot pass its incoming-edge
  // check between this read and the insert that references it.
  const [row] = await tx
    .select({ id: vendor.id })
    .from(vendor)
    .where(and(eq(vendor.id, id), notDeleted(vendor)))
    .for("share")
    .limit(1);
  if (!row)
    throw createAppError("VENDOR_NOT_FOUND", `Vendor not found: ${shortcode}`);
  return row.id;
}

function assertProviderMatchesKind(
  identity: FinancialAccountCreateInput["identity"],
  providerVendorId: string | null,
) {
  if (providerVendorId !== null && identity.kind !== "stored_value")
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Only a stored-value account names a provider vendor; this account is ${identity.kind}.`,
    );
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
    const { ledgerPartyId, providerVendorId, ...columns } = data;
    const resolvedLedgerPartyId = await resolveLedgerPartyForAccount(
      tx,
      ledgerPartyId,
    );
    const resolvedProviderVendorId = await resolveProviderVendorForAccount(
      tx,
      providerVendorId,
    );
    assertProviderMatchesKind(data.identity, resolvedProviderVendorId);
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
      providerVendorId: resolvedProviderVendorId,
    });
    await logAuditEntry(tx, actor, {
      entityKind: "financialAccount",
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
  const output = await withTransaction(db, async (tx) => {
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
    const providerVendorId =
      data.providerVendorId === undefined
        ? undefined
        : await resolveProviderVendorForAccount(tx, data.providerVendorId);
    assertProviderMatchesKind(
      data.identity ?? financialAccountIdentity.parse(before.identity),
      providerVendorId === undefined
        ? before.providerVendorId
        : providerVendorId,
    );
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
    const {
      ledgerPartyId: _ledgerPartyId,
      providerVendorId: _providerVendorId,
      ...accountData
    } = data;
    const updateData: Partial<typeof financialAccount.$inferInsert> = {
      ...accountData,
    };
    if (ledgerPartyId !== undefined) updateData.ledgerPartyId = ledgerPartyId;
    if (providerVendorId !== undefined)
      updateData.providerVendorId = providerVendorId;
    return financialAccountCrud.update(tx, accountId, updateData, actor);
  });
  return { output, entityId: accountId };
}

export const financialAccountRepository = defineRepository("financialAccount", {
  lifecycle: { delete: FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY },
  get: onDb(getFinancialAccountByShortcode),
  list: listOn(listFinancialAccounts),
  listRead: listReadOn(listFinancialAccountsRead),
  create: asActor(createFinancialAccount),
  update: asActor(updateFinancialAccount),
});
