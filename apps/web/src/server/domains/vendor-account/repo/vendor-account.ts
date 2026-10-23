import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type {
  VendorAccountId,
  VendorAccountShortcode,
  VendorId,
} from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type {
  VendorAccountCreateInput,
  VendorAccountFilters,
  VendorAccountOut,
  VendorAccountUpdateData,
} from "@cubby/schemas/vendor-account";
import { vendorAccountOut } from "@cubby/schemas/vendor-account";
import { vendorAccountCursor } from "@cubby/schemas/vendor-account-fields";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
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
import { notDeleted, unwrapDb, withTransaction } from "~/server/db/helpers";
import type { ListReadIntent } from "~/server/db/helpers/query";
import { ledgerParty, purchase, run, vendorAccount } from "~/server/db/schema";
import { patchEntityRows } from "~/server/entity-kernel/repo/entity-patch";
import {
  type MutationReceipt,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import {
  asActor,
  defineRepository,
  listOn,
  listReadOn,
  onDb,
} from "~/server/entity-kernel/repo/repository";
import { createEntityReader } from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import {
  listReadPlan,
  type ListReadOptions,
} from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";
import { finalizeMerge } from "~/server/generic/merge/repo/core";
import { applyMergePolicy } from "~/server/generic/removal/repo/dispositions";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
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

/**
 * Folding a duplicate member account into the surviving one. Source claims
 * stay unique by member, kind and key; the account only scopes them, so a
 * repoint cannot collide.
 */
const VENDOR_ACCOUNT_FOLD_EDGE_POLICY = {
  "Purchase.vendorAccountId": {
    code: "repoint-purchases",
    effect: "repoint",
    description:
      "Purchases fetched through the duplicate account name the surviving account.",
  },
  "Run.vendorAccountId": {
    code: "repoint-runs",
    effect: "repoint",
    description: "Import runs move their scope to the surviving account.",
  },
  "ImportSourceClaim.vendorAccountId": {
    code: "repoint-source-claims",
    effect: "repoint",
    description: "Replay-safe source claims scope to the surviving account.",
  },
} as const satisfies IncomingEdgePolicy<"vendorAccount", OperationDisposition>;

const newestOrderAt = (cursor: unknown) =>
  vendorAccountCursor.safeParse(cursor).data?.newestOrderAt ?? "";

const laterCursor = (
  a: typeof vendorAccount.$inferSelect.cursor,
  b: typeof vendorAccount.$inferSelect.cursor,
) => (newestOrderAt(b) > newestOrderAt(a) ? b : a);

/**
 * A Vendor merge's `fold-member-accounts`: each loser account moves to the
 * keeper, or, when the keeper already has an account for that member, folds
 * into it (references re-pointed, later sync cursor kept, duplicate retired).
 */
export async function foldVendorAccountsInto(
  tx: DrizzleTransaction,
  args: {
    keepVendorId: VendorId;
    loserVendorIds: readonly VendorId[];
    actor: ActorContext;
  },
): Promise<{ moved: number; folded: number }> {
  const accounts = await tx
    .select()
    .from(vendorAccount)
    .where(
      and(
        inArray(vendorAccount.vendorId, [
          args.keepVendorId,
          ...args.loserVendorIds,
        ]),
        notDeleted(vendorAccount),
      ),
    )
    .orderBy(vendorAccount.createdAt)
    .for("update");
  const survivors = new Map(
    accounts
      .filter((account) => account.vendorId === args.keepVendorId)
      .map((account) => [account.ledgerPartyId, account]),
  );
  let moved = 0;
  let folded = 0;
  for (const account of accounts) {
    if (account.vendorId === args.keepVendorId) continue;
    const survivor = survivors.get(account.ledgerPartyId);
    if (!survivor) {
      await tx
        .update(vendorAccount)
        .set({ vendorId: args.keepVendorId })
        .where(eq(vendorAccount.id, account.id));
      await logAuditEntry(tx, args.actor, {
        entityKind: "vendorAccount",
        entityId: account.id,
        action: "update",
        changes: {
          vendorId: { from: account.vendorId, to: args.keepVendorId },
        },
      });
      survivors.set(account.ledgerPartyId, {
        ...account,
        vendorId: args.keepVendorId,
      });
      moved++;
      continue;
    }
    // `Run_one_active_vendor_account_key`: one live Run per account.
    const active = await tx
      .select({ vendorAccountId: run.vendorAccountId })
      .from(run)
      .where(
        and(
          inArray(run.vendorAccountId, [survivor.id, account.id]),
          inArray(run.status, [...ACTIVE_RUN_STATUSES]),
        ),
      );
    if (new Set(active.map((row) => row.vendorAccountId)).size > 1)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Both vendor accounts ${survivor.shortcode} and ${account.shortcode} have an active import Run; finish or stop one before merging their vendors.`,
      );
    await applyMergePolicy(tx, {
      entity: "vendorAccount",
      policy: VENDOR_ACCOUNT_FOLD_EDGE_POLICY,
      keepId: parseEntityId("vendorAccount", survivor.id),
      loserIds: [parseEntityId("vendorAccount", account.id)],
      liveOnly: false,
    });
    const cursor = laterCursor(survivor.cursor, account.cursor);
    const inventoryOwnerDefaultEnabled =
      survivor.inventoryOwnerDefaultEnabled ||
      account.inventoryOwnerDefaultEnabled;
    const survivorChanges = {
      mergedFrom: { from: null, to: [account.id] },
      ...(cursor !== survivor.cursor
        ? { cursor: { from: survivor.cursor, to: cursor } }
        : {}),
      ...(inventoryOwnerDefaultEnabled !== survivor.inventoryOwnerDefaultEnabled
        ? {
            inventoryOwnerDefaultEnabled: {
              from: survivor.inventoryOwnerDefaultEnabled,
              to: inventoryOwnerDefaultEnabled,
            },
          }
        : {}),
    };
    await tx
      .update(vendorAccount)
      .set({ cursor, inventoryOwnerDefaultEnabled })
      .where(eq(vendorAccount.id, survivor.id));
    survivors.set(account.ledgerPartyId, {
      ...survivor,
      cursor,
      inventoryOwnerDefaultEnabled,
    });
    await finalizeMerge(tx, {
      entity: "vendorAccount",
      table: vendorAccount,
      keepId: parseEntityId("vendorAccount", survivor.id),
      loserIds: [parseEntityId("vendorAccount", account.id)],
      removal: "soft",
      actor: args.actor,
      survivorChanges,
    });
    folded++;
  }
  return { moved, folded };
}

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
const accountRead = {
  references: {
    vendorId: {
      kind: "lookup",
      name: "vendorName",
      missing: "error",
      includeDeleted: true,
    },
    ledgerPartyId: {
      kind: "lookup",
      name: "ledgerPartyName",
      missing: "error",
      includeDeleted: true,
    },
  },
  bindings: (bind) => {
    const activity = bind.batch(({ db, rows }) =>
      loadVendorAccountRunActivity(
        db,
        rows.map((row) => row.id),
      ),
    );
    const counts = bind.batch(async ({ db, rows }) => {
      const values = await unwrapDb(db)
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
      return new Map(values.map((row) => [row.accountId, row.count]));
    });
    return [
      activity.fields(
        vendorAccountOut.pick({ lastRunAt: true, lastSuccessAt: true }),
        (row, loaded) => ({
          lastRunAt: loaded.get(row.id)?.lastRunAt ?? null,
          lastSuccessAt: loaded.get(row.id)?.lastSuccessAt ?? null,
        }),
      ),
      counts.fields(
        vendorAccountOut.pick({ purchaseCount: true }),
        (row, loaded) => ({ purchaseCount: loaded.get(row.id) ?? 0 }),
      ),
    ];
  },
} satisfies ListReadOptions<VendorAccountRow>;
const hydrateRead = (
  db: Database | DrizzleTransaction,
  rows: VendorAccountRow[],
  projection: ListProjection,
) =>
  listReadPlan<VendorAccountRow>("vendorAccount", accountRead).read(
    db,
    rows,
    projection,
  );
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
  scaffold.where(filters);

export const listVendorAccountsRead = (
  db: Database,
  filters: VendorAccountFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
  readIntent: ListReadIntent = "page",
) =>
  scaffold.read(
    db,
    { filters, sorts, pagination, projection, readIntent },
    {
      where: buildVendorAccountWhere(filters),
      select: (page) =>
        selectVendorAccounts(db)
          .where(page.where)
          .orderBy(...page.orderBy)
          .limit(page.limit)
          .offset(page.offset),
      read: accountRead,
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

export const createVendorAccount = defineMutationWriter({
  entity: "vendorAccount",
  read: async (
    receipt: MutationReceipt<"vendorAccount">,
    db: Database,
    _data: VendorAccountCreateInput,
    _actor: ActorContext,
  ) => ({
    output: await reader.getByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    data: VendorAccountCreateInput,
    actor: ActorContext,
  ) => {
    const id = await withTransaction(db, async (tx) => {
      const refs = await resolveReferences(tx, data);
      const row = await insertWithShortcode(tx, "vendorAccount", {
        ...refs,
        inventoryOwnerDefaultEnabled: data.inventoryOwnerDefaultEnabled,
      });
      await logAuditEntry(tx, actor, {
        entityKind: "vendorAccount",
        entityId: row.id,
        action: "create",
      });
      return parseEntityId("vendorAccount", row.id);
    });
    return readOutput({ entityId: id });
  },
});

const updateVendorAccount = defineMutationWriter({
  entity: "vendorAccount",
  read: async (
    receipt: MutationReceipt<"vendorAccount">,
    db: Database,
    _shortcode: VendorAccountShortcode,
    _data: VendorAccountUpdateData,
    _actor: ActorContext,
  ) => ({
    output: await reader.getByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    shortcode: VendorAccountShortcode,
    data: VendorAccountUpdateData,
    actor: ActorContext,
  ) => {
    const id = await resolveOrThrow(db, "vendorAccount", shortcode);
    const refs: VendorAccountReferencePatch = {};
    if (data.vendorId) {
      refs.vendorId = await resolveOrThrow(db, "vendor", data.vendorId);
    }
    if (data.ledgerPartyId) {
      refs.ledgerPartyId = await resolveMemberParty(db, data.ledgerPartyId);
    }
    const patch = {
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
    return readOutput({ entityId: id });
  },
});

export const vendorAccountRepository = defineRepository("vendorAccount", {
  lifecycle: { delete: VENDOR_ACCOUNT_DELETE_EDGE_POLICY },
  get: onDb(getVendorAccountByShortcode),
  list: listOn(listVendorAccounts),
  listRead: listReadOn(listVendorAccountsRead),
  create: asActor(createVendorAccount),
  update: asActor(updateVendorAccount),
});
