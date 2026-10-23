import type { LedgerPartyId } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import type {
  EntityKernelContext,
  EntityRepository,
} from "~/server/entity-kernel/adapter";
import {
  defineRepository,
  listOn,
  listReadOn,
  onDb,
} from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";
import { bindShortcodeResolver } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  checkUniqueProductDuplicate,
  createInventoryEntry,
  deleteInventoryEntries,
  getInventoryEntryByShortcode,
  INVENTORY_DELETE_EDGE_POLICY,
  inventoryentryList,
  inventoryentryListRead,
  inventoryentryListSummary,
  updateInventoryEntry,
} from "./crud";

const inventoryShortcodes = bindShortcodeResolver("inventory");
const productShortcodes = bindShortcodeResolver("product");
const locationShortcodes = bindShortcodeResolver("location");
const ledgerPartyShortcodes = bindShortcodeResolver("ledgerParty");

const resolveOptionalOwner = async (
  db: Database,
  shortcode: string | null | undefined,
): Promise<LedgerPartyId | null | undefined> =>
  shortcode === undefined
    ? undefined
    : shortcode === null
      ? null
      : await ledgerPartyShortcodes.one(db, shortcode);

type CreateInput = Parameters<
  NonNullable<EntityRepository<"inventory">["create"]>
>[1];
type UpdateInput = Parameters<
  NonNullable<EntityRepository<"inventory">["update"]>
>[2];
const resolveCreate = async (ctx: EntityKernelContext, data: CreateInput) => {
  const [productId, locationId, ownerLedgerPartyId] = await Promise.all([
    productShortcodes.one(ctx.db, data.productId),
    locationShortcodes.one(ctx.db, data.locationId),
    resolveOptionalOwner(ctx.db, data.ownerLedgerPartyId),
  ]);
  const duplicate = await checkUniqueProductDuplicate(
    ctx.db,
    productId,
    locationId,
  );
  if (duplicate)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Unique product ${duplicate.productName} is already inventoried at ${duplicate.locationName}`,
    );
  return { ...data, productId, locationId, ownerLedgerPartyId };
};
const resolveUpdate = async (ctx: EntityKernelContext, data: UpdateInput) => {
  const [productId, locationId, ownerLedgerPartyId] = await Promise.all([
    data.productId ? productShortcodes.one(ctx.db, data.productId) : undefined,
    data.locationId
      ? locationShortcodes.one(ctx.db, data.locationId)
      : undefined,
    resolveOptionalOwner(ctx.db, data.ownerLedgerPartyId),
  ]);
  return { ...data, productId, locationId, ownerLedgerPartyId };
};

export const inventoryRepository = defineRepository("inventory", {
  lifecycle: { delete: INVENTORY_DELETE_EDGE_POLICY },
  get: onDb(getInventoryEntryByShortcode),
  list: listOn(inventoryentryList),
  listRead: listReadOn(inventoryentryListRead),
  listSummary: (ctx, filters) => inventoryentryListSummary(ctx.db, filters),
  create: async (ctx, data) =>
    createInventoryEntry(
      ctx.db,
      await resolveCreate(ctx, data),
      ctx.actorContext,
    ),
  createRead: async (ctx, data, fields) =>
    createInventoryEntry.read(
      fields,
      ctx.db,
      await resolveCreate(ctx, data),
      ctx.actorContext,
    ),
  update: async (ctx, shortcode, data) => {
    const entityId = await inventoryShortcodes.one(ctx.db, shortcode);
    const output = await updateInventoryEntry(
      ctx.db,
      entityId,
      await resolveUpdate(ctx, data),
      ctx.actorContext,
    );
    return {
      output,
      entityId:
        output.id === shortcode
          ? entityId
          : await inventoryShortcodes.one(ctx.db, output.id),
    };
  },
  updateRead: async (ctx, shortcode, data, fields) =>
    updateInventoryEntry.read(
      fields,
      ctx.db,
      await inventoryShortcodes.one(ctx.db, shortcode),
      await resolveUpdate(ctx, data),
      ctx.actorContext,
    ),
  delete: async (ctx, shortcodes) => {
    const ids = await inventoryShortcodes.all(ctx.db, shortcodes);
    await deleteInventoryEntries(ctx.db, ids, ctx.actorContext);
    await recordChange(ctx.db, { kind: "source", categories: ["inventory"] });
  },
});
