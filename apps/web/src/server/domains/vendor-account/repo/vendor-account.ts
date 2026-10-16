import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type {
  VendorAccountId,
  VendorAccountShortcode,
} from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type {
  VendorAccountCreateInput,
  VendorAccountFilters,
  VendorAccountOut,
  VendorAccountUpdateData,
} from "@cubby/schemas/vendor-account";
import { vendorAccountOut } from "@cubby/schemas/vendor-account";
import {
  and,
  count,
  eq,
  getTableColumns,
  inArray,
  max,
  sql,
} from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { vendorAccountLabelSql } from "~/server/db/computed/vendor-account-label";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  formatSearchTerm,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/db/helpers";
import { ledgerParty, purchase, run, vendorAccount } from "~/server/db/schema";
import { patchEntityRows } from "~/server/entity-kernel/repo/entity-patch";
import {
  asActor,
  defineRepository,
  listOn,
  listReadOn,
  onDb,
} from "~/server/entity-kernel/repo/repository";
import { createEntityReader } from "~/server/entity-kernel/repo/repository";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { listScaffold } from "~/server/generic/list/repo/list";
import {
  hydrateListRead,
  loadListGroup,
  type ListProjection,
  type ListReadRow,
  wantsListGroup,
} from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";
import {
  lookupEntityReferences,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

const VENDOR_ACCOUNT_DELETE_EDGE_POLICY = {
  "Purchase.vendorAccountId": {
    code: "block-purchases",
    effect: "block",
    description:
      "Fetched purchases retain the vendor account that supplied their evidence.",
  },
  "Run.vendorAccountId": {
    code: "block-runs",
    effect: "block",
    description: "Import runs retain their vendor-account scope.",
  },
  "ImportSourceClaim.vendorAccountId": {
    code: "block-source-claims",
    effect: "block",
    description: "Replay-safe source claims retain their vendor-account scope.",
  },
} as const satisfies IncomingEdgePolicy<"vendorAccount", OperationDisposition>;

type VendorAccountRow = typeof vendorAccount.$inferSelect & {
  displayName: string;
};

/** Every account read carries its derived `<vendor> · <member>` title. */
const selectVendorAccounts = (db: Database | DrizzleTransaction) =>
  unwrapDb(db)
    .select({
      ...getTableColumns(vendorAccount),
      displayName: vendorAccountLabelSql,
    })
    .from(vendorAccount);

/**
 * When each account last ran and last finished a run, read from Run (served by
 * `Run_vendorAccount_started_idx`) rather than stored on the account, so the
 * two can never disagree with the run history they summarize.
 */
export const loadVendorAccountRunActivity = async (
  db: Database | DrizzleTransaction,
  ids: readonly VendorAccountId[],
) => {
  const activity = new Map<
    VendorAccountId,
    { lastRunAt: Date | null; lastSuccessAt: Date | null }
  >();
  if (ids.length === 0) return activity;
  const rows = await unwrapDb(db)
    .select({
      vendorAccountId: run.vendorAccountId,
      lastRunAt: max(run.startedAt),
      lastSuccessAt:
        sql<Date | null>`max(${run.endedAt}) FILTER (WHERE ${run.status} = 'completed')`.mapWith(
          run.endedAt,
        ),
    })
    .from(run)
    .where(inArray(run.vendorAccountId, [...ids]))
    .groupBy(run.vendorAccountId);
  for (const row of rows) {
    if (row.vendorAccountId === null) continue;
    activity.set(parseEntityId("vendorAccount", row.vendorAccountId), {
      lastRunAt: row.lastRunAt,
      lastSuccessAt: row.lastSuccessAt,
    });
  }
  return activity;
};

// includes-deleted: both FKs are required, so a tombstoned vendor or party
// still names the account's scope rather than failing the read.
const hydrateRead = async (
  db: Database | DrizzleTransaction,
  rows: VendorAccountRow[],
  projection: ListProjection,
): Promise<ListReadRow[]> => {
  return hydrateListRead(db, "vendorAccount", rows, projection, {
    load: () =>
      Promise.all([
        loadListGroup(projection, "relations", () =>
          lookupEntityReferences(
            db,
            "vendor",
            rows.map((row) => row.vendorId),
            { includeDeleted: true },
          ),
        ),
        loadListGroup(projection, "relations", () =>
          lookupEntityReferences(
            db,
            "ledgerParty",
            rows.map((row) => row.ledgerPartyId),
            { includeDeleted: true },
          ),
        ),
        loadListGroup(projection, "derived", () =>
          loadVendorAccountRunActivity(
            db,
            rows.map((row) => row.id),
          ),
        ),
        loadListGroup(projection, "derived", async () => {
          if (rows.length === 0) return new Map();
          const counts = await unwrapDb(db)
            .select({ accountId: purchase.vendorAccountId, count: count() })
            .from(purchase)
            .where(
              and(
                inArray(
                  purchase.vendorAccountId,
                  rows.map((row) => row.id),
                ),
                notDeleted(purchase),
              ),
            )
            .groupBy(purchase.vendorAccountId);
          return new Map(counts.map((row) => [row.accountId, row.count]));
        }),
      ]),
    mapRow: (row, { loaded: [vendors, parties, activity, purchaseCounts] }) => {
      const vendor = vendors?.get(row.vendorId);
      const party = parties?.get(row.ledgerPartyId);
      const result = {
        ...row,
        id: parseShortcodeFor("vendorAccount", row.shortcode),
      };
      if (activity)
        Object.assign(result, {
          lastRunAt: activity.get(row.id)?.lastRunAt ?? null,
          lastSuccessAt: activity.get(row.id)?.lastSuccessAt ?? null,
          purchaseCount: purchaseCounts?.get(row.id) ?? 0,
        });
      if (wantsListGroup(projection, "relations"))
        Object.assign(result, {
          vendorId: vendor?.id,
          vendorName: vendor?.name,
          ledgerPartyId: party?.id,
          ledgerPartyName: party?.name,
        });
      return result;
    },
  });
};
const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: VendorAccountRow[],
): Promise<VendorAccountOut[]> =>
  (await hydrateRead(db, rows, { kind: "full" })).map((row) =>
    vendorAccountOut.parse(row),
  );

// `lastRunAt` and `displayName` are computed, not columns.
const scaffold = listScaffold("vendorAccount", vendorAccount, {
  derived: {
    displayName: { sql: vendorAccountLabelSql, nulls: "high" },
    lastRunAt: sql`(SELECT max(r."startedAt") FROM "Run" r WHERE r."vendorAccountId" = ${vendorAccount.id})`,
  },
});

type VendorAccountReferencePatch = {
  vendorId?: ReturnType<typeof parseEntityId<"vendor">>;
  ledgerPartyId?: ReturnType<typeof parseEntityId<"ledgerParty">>;
};

export const buildVendorAccountWhere = (filters: VendorAccountFilters) =>
  scaffold.where(filters, [
    formatSearchTerm(vendorAccountLabelSql, filters.search),
  ]);

export const listVendorAccountsRead = (
  db: Database,
  filters: VendorAccountFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
) =>
  scaffold.list(
    db,
    { filters, sorts, pagination, projection },
    {
      where: buildVendorAccountWhere(filters),
      select: (page) =>
        selectVendorAccounts(db)
          .where(page.where)
          .orderBy(...page.orderBy)
          .limit(page.limit)
          .offset(page.offset),
      hydrate: (rows, selected) => hydrateRead(db, rows, selected),
    },
  );

const listVendorAccounts = completeListReader(
  vendorAccountOut,
  listVendorAccountsRead,
);

const reader = createEntityReader<
  VendorAccountRow,
  VendorAccountOut,
  "vendorAccount",
  Database | DrizzleTransaction
>({
  entity: "vendorAccount",
  fetchById: async (db, id) => {
    const [row] = await selectVendorAccounts(db)
      .where(and(eq(vendorAccount.id, id), notDeleted(vendorAccount)))
      .limit(1);
    return row;
  },
  fromDB: async (db, row) => (await hydrate(db, [row]))[0]!,
});

export const getVendorAccountByShortcode = reader.getByShortcode;

async function resolveReferences(
  db: Database | DrizzleTransaction,
  data: Pick<VendorAccountCreateInput, "vendorId" | "ledgerPartyId">,
) {
  return {
    vendorId: await resolveOrThrow(db, "vendor", data.vendorId),
    ledgerPartyId: await resolveMemberParty(db, data.ledgerPartyId),
  };
}

async function resolveMemberParty(
  db: Database | DrizzleTransaction,
  shortcode: VendorAccountCreateInput["ledgerPartyId"],
) {
  const ledgerPartyId = await resolveOrThrow(db, "ledgerParty", shortcode);
  const [party] = await unwrapDb(db)
    .select({ kind: ledgerParty.kind })
    .from(ledgerParty)
    .where(and(eq(ledgerParty.id, ledgerPartyId), notDeleted(ledgerParty)))
    .limit(1);
  if (party?.kind !== "member") {
    throw new Error("Vendor accounts must belong to a member ledger party");
  }
  return ledgerPartyId;
}

export async function createVendorAccount(
  db: Database,
  data: VendorAccountCreateInput,
  actor: ActorContext,
): Promise<{ output: VendorAccountOut; entityId: VendorAccountId }> {
  const id = await withTransaction(db, async (tx) => {
    const refs = await resolveReferences(tx, data);
    const row = await insertWithShortcode(tx, "vendorAccount", {
      ...refs,
      status: data.status,
      inventoryOwnerDefaultEnabled: data.inventoryOwnerDefaultEnabled,
    });
    await logAuditEntry(tx, actor, {
      entityKind: "vendorAccount",
      entityId: row.id,
      action: "create",
    });
    return parseEntityId("vendorAccount", row.id);
  });
  return { output: await reader.getByID(db, id), entityId: id };
}

async function updateVendorAccount(
  db: Database,
  shortcode: VendorAccountShortcode,
  data: VendorAccountUpdateData,
  actor: ActorContext,
): Promise<{ output: VendorAccountOut; entityId: VendorAccountId }> {
  const id = await resolveOrThrow(db, "vendorAccount", shortcode);
  const refs: VendorAccountReferencePatch = {};
  if (data.vendorId) {
    refs.vendorId = await resolveOrThrow(db, "vendor", data.vendorId);
  }
  if (data.ledgerPartyId) {
    refs.ledgerPartyId = await resolveMemberParty(db, data.ledgerPartyId);
  }
  const patch = {
    status: data.status,
    inventoryOwnerDefaultEnabled: data.inventoryOwnerDefaultEnabled,
    ...refs,
  };
  await withTransaction(db, async (tx) => {
    await patchEntityRows(
      tx,
      actor,
      {
        entity: "vendorAccount",
        table: vendorAccount,
        fields: entityFieldModels.vendorAccount.audit,
      },
      [id],
      patch,
    );
  });
  return { output: await reader.getByID(db, id), entityId: id };
}

export const vendorAccountRepository = defineRepository("vendorAccount", {
  lifecycle: { delete: VENDOR_ACCOUNT_DELETE_EDGE_POLICY },
  get: onDb(getVendorAccountByShortcode),
  list: listOn(listVendorAccounts),
  listRead: listReadOn(listVendorAccountsRead),
  create: asActor(createVendorAccount),
  update: asActor(updateVendorAccount),
});
