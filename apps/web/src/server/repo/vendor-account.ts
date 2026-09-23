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
import { and, eq, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { ledgerParty, vendorAccount } from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  auditDateWhereConditions,
  countWhere,
  executeListQueryWithCount,
  getDb,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { patchEntityRows } from "~/server/repo/entity-patch";
import { listScaffold } from "~/server/repo/list-scaffold";
import { removeEntity } from "~/server/repo/removal";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

export const VENDOR_ACCOUNT_DELETE_EDGE_POLICY = {
  "Purchase.vendorAccountId": {
    code: "block-purchases",
    effect: "block",
    description:
      "Fetched purchases retain the vendor account that supplied their evidence.",
  },
  "ImportRun.vendorAccountId": {
    code: "block-runs",
    effect: "block",
    description: "Import runs retain their vendor-account scope.",
  },
  "ImportRunTarget.vendorAccountId": {
    code: "block-targeted-runs",
    effect: "block",
    description:
      "Targeted validation and enrichment retain the account selected for their evidence.",
  },
  "ImportSourceClaim.vendorAccountId": {
    code: "block-source-claims",
    effect: "block",
    description: "Replay-safe source claims retain their vendor-account scope.",
  },
  "ImportHunt.vendorAccountId": {
    code: "block-hunts",
    effect: "block",
    description: "Import hunts retain their assigned vendor account.",
  },
} as const satisfies IncomingEdgePolicy<"vendorAccount", OperationDisposition>;

const columns = {
  id: vendorAccount.id,
  shortcode: vendorAccount.shortcode,
  label: vendorAccount.label,
  vendorShortcode: sql<string>`(SELECT shortcode FROM "Vendor" WHERE id = "VendorAccount"."vendorId")`,
  vendorName: sql<string>`(SELECT name FROM "Vendor" WHERE id = "VendorAccount"."vendorId")`,
  ledgerPartyShortcode: sql<string>`(SELECT shortcode FROM "LedgerParty" WHERE id = "VendorAccount"."ledgerPartyId")`,
  ledgerPartyName: sql<string>`(SELECT name FROM "LedgerParty" WHERE id = "VendorAccount"."ledgerPartyId")`,
  status: vendorAccount.status,
  browser: vendorAccount.browser,
  inventoryOwnerDefaultEnabled: vendorAccount.inventoryOwnerDefaultEnabled,
  cursor: vendorAccount.cursor,
  lastRunAt: vendorAccount.lastRunAt,
  lastSuccessAt: vendorAccount.lastSuccessAt,
  createdAt: vendorAccount.createdAt,
  updatedAt: vendorAccount.updatedAt,
} as const;

type VendorAccountRow = {
  id: string;
  shortcode: string;
  label: string;
  vendorShortcode: string;
  vendorName: string;
  ledgerPartyShortcode: string;
  ledgerPartyName: string;
  status: typeof vendorAccount.$inferSelect.status;
  browser: typeof vendorAccount.$inferSelect.browser;
  inventoryOwnerDefaultEnabled: boolean;
  cursor: typeof vendorAccount.$inferSelect.cursor;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const toOut = (row: VendorAccountRow): VendorAccountOut =>
  vendorAccountOut.parse({
    ...row,
    id: parseShortcodeFor("vendorAccount", String(row.shortcode)),
    vendorId: parseShortcodeFor("vendor", String(row.vendorShortcode)),
    ledgerPartyId: parseShortcodeFor(
      "ledgerParty",
      String(row.ledgerPartyShortcode),
    ),
  });

const scaffold = listScaffold("vendorAccount", vendorAccount);

type VendorAccountReferencePatch = {
  vendorId?: ReturnType<typeof parseEntityId<"vendor">>;
  ledgerPartyId?: ReturnType<typeof parseEntityId<"ledgerParty">>;
};

export const buildVendorAccountWhere = (filters: VendorAccountFilters) =>
  scaffold.where(filters, [
    ...auditDateWhereConditions(vendorAccount, filters),
  ]);

export async function listVendorAccounts(
  db: Database,
  filters: VendorAccountFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) {
  const where = buildVendorAccountWhere(filters);
  const { take, skip } = scaffold.page(pagination);
  const { data, count } = await executeListQueryWithCount(
    getDb(db)
      .select(columns)
      .from(vendorAccount)
      .where(where)
      .orderBy(...scaffold.orderBy(sorts, {}, filters))
      .limit(take)
      .offset(skip),
    countWhere(db, vendorAccount, where),
  );
  return { data: data.map((row) => toOut(row)), count };
}

const reader = createEntityReader<
  VendorAccountRow,
  VendorAccountOut,
  "vendorAccount",
  Database | DrizzleTransaction
>({
  entity: "vendorAccount",
  fetchById: async (db, id) => {
    const [row] = await unwrapDb(db)
      .select(columns)
      .from(vendorAccount)
      .where(and(eq(vendorAccount.id, id), notDeleted(vendorAccount)))
      .limit(1);
    return row;
  },
  fromDB: (_db, row) => toOut(row),
});

export const getVendorAccountByShortcode = reader.getByShortcode;

async function resolveReferences(
  db: Database | DrizzleTransaction,
  data: Pick<VendorAccountCreateInput, "vendorId" | "ledgerPartyId">,
) {
  const vendorId = await resolveOrThrow(db, "vendor", data.vendorId);
  const ledgerPartyId = await resolveOrThrow(
    db,
    "ledgerParty",
    data.ledgerPartyId,
  );
  const [party] = await unwrapDb(db)
    .select({ kind: ledgerParty.kind })
    .from(ledgerParty)
    .where(and(eq(ledgerParty.id, ledgerPartyId), notDeleted(ledgerParty)))
    .limit(1);
  if (party?.kind !== "member") {
    throw new Error("Vendor accounts must belong to a member ledger party");
  }
  return { vendorId, ledgerPartyId };
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
      label: data.label.trim(),
      ...refs,
      status: data.status,
      browser: data.browser,
      inventoryOwnerDefaultEnabled: data.inventoryOwnerDefaultEnabled,
    });
    await logAuditEntry(tx, actor, {
      entityType: "vendorAccount",
      entityId: row.id,
      action: "create",
    });
    return parseEntityId("vendorAccount", row.id);
  });
  return { output: await reader.getByID(db, id), entityId: id };
}

export async function updateVendorAccount(
  db: Database,
  shortcode: VendorAccountShortcode,
  data: VendorAccountUpdateData,
  actor: ActorContext,
): Promise<{ output: VendorAccountOut; entityId: VendorAccountId }> {
  const id = await resolveOrThrow(db, "vendorAccount", shortcode);
  const refs: VendorAccountReferencePatch = {};
  if (data.vendorId && data.ledgerPartyId) {
    Object.assign(
      refs,
      await resolveReferences(db, {
        vendorId: data.vendorId,
        ledgerPartyId: data.ledgerPartyId,
      }),
    );
  } else {
    if (data.vendorId) {
      refs.vendorId = await resolveOrThrow(db, "vendor", data.vendorId);
    }
    if (data.ledgerPartyId) {
      refs.ledgerPartyId = await resolveMemberParty(db, data.ledgerPartyId);
    }
  }
  const patch = {
    label: data.label?.trim(),
    status: data.status,
    browser: data.browser,
    inventoryOwnerDefaultEnabled: data.inventoryOwnerDefaultEnabled,
    ...refs,
  };
  await patchEntityRows(
    db,
    actor,
    {
      entity: "vendorAccount",
      table: vendorAccount,
      fields: entityFieldModels.vendorAccount.audit,
    },
    [id],
    patch,
  );
  return { output: await reader.getByID(db, id), entityId: id };
}

export async function deleteVendorAccounts(
  db: Database,
  shortcodes: VendorAccountShortcode[],
  actor: ActorContext,
) {
  const ids = uniq(await resolveAllOrThrow(db, "vendorAccount", shortcodes));
  return withTransaction(db, async (tx) => {
    await removeEntity(tx, {
      entity: "vendorAccount",
      ids,
      removal: "soft",
      actor,
    });
    return { deleted: ids.length };
  });
}
