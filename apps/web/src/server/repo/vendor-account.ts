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
import { and, eq } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { ledgerParty, vendorAccount } from "~/server/db/schema";
import { entityRepository } from "~/server/entity-kernel/adapter";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { patchEntityRows } from "~/server/repo/entity-patch";
import { listScaffold } from "~/server/repo/list-scaffold";
import {
  lookupEntityReferences,
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

type VendorAccountRow = typeof vendorAccount.$inferSelect;

// includes-deleted: both FKs are required, so a tombstoned vendor or party
// still names the account's scope rather than failing the read.
const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: VendorAccountRow[],
): Promise<VendorAccountOut[]> => {
  const [vendors, parties] = await Promise.all([
    lookupEntityReferences(
      db,
      "vendor",
      rows.map((row) => row.vendorId),
      { includeDeleted: true },
    ),
    lookupEntityReferences(
      db,
      "ledgerParty",
      rows.map((row) => row.ledgerPartyId),
      { includeDeleted: true },
    ),
  ]);
  return rows.map((row) => {
    const vendor = vendors.get(row.vendorId);
    const party = parties.get(row.ledgerPartyId);
    return vendorAccountOut.parse({
      ...row,
      id: parseShortcodeFor("vendorAccount", row.shortcode),
      vendorId: vendor?.id,
      vendorName: vendor?.name,
      ledgerPartyId: party?.id,
      ledgerPartyName: party?.name,
    });
  });
};

const scaffold = listScaffold("vendorAccount", vendorAccount);

type VendorAccountReferencePatch = {
  vendorId?: ReturnType<typeof parseEntityId<"vendor">>;
  ledgerPartyId?: ReturnType<typeof parseEntityId<"ledgerParty">>;
};

export const buildVendorAccountWhere = (filters: VendorAccountFilters) =>
  scaffold.where(filters);

export const listVendorAccounts = (
  db: Database,
  filters: VendorAccountFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) =>
  scaffold.list(
    db,
    { filters, sorts, pagination },
    { hydrate: (rows) => hydrate(db, rows) },
  );

const reader = createEntityReader<
  VendorAccountRow,
  VendorAccountOut,
  "vendorAccount",
  Database | DrizzleTransaction
>({
  entity: "vendorAccount",
  fetchById: async (db, id) => {
    const [row] = await unwrapDb(db)
      .select()
      .from(vendorAccount)
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
  if (data.vendorId) {
    refs.vendorId = await resolveOrThrow(db, "vendor", data.vendorId);
  }
  if (data.ledgerPartyId) {
    refs.ledgerPartyId = await resolveMemberParty(db, data.ledgerPartyId);
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

export const vendorAccountRepository = entityRepository("vendorAccount", {
  lifecycle: { delete: VENDOR_ACCOUNT_DELETE_EDGE_POLICY },
  get: getVendorAccountByShortcode,
  list: listVendorAccounts,
  create: createVendorAccount,
  update: updateVendorAccount,
});
