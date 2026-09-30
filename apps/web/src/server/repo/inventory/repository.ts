import type { LedgerPartyId } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  defineRepository,
  listOn,
  listReadOn,
  onDb,
} from "~/server/repo/repository";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import {
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";

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

export const inventoryRepository = defineRepository("inventory", {
  lifecycle: { delete: INVENTORY_DELETE_EDGE_POLICY },
  get: onDb(getInventoryEntryByShortcode),
  list: listOn(inventoryentryList),
  listRead: listReadOn(inventoryentryListRead),
  listSummary: (ctx, filters) => inventoryentryListSummary(ctx.db, filters),
  create: async (ctx, data) => {
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
    return createInventoryEntry(
      ctx.db,
      { ...data, productId, locationId, ownerLedgerPartyId },
      ctx.actorContext,
    );
  },
  update: async (ctx, shortcode, data) => {
    const entityId = await inventoryShortcodes.one(ctx.db, shortcode);
    const [productId, locationId, ownerLedgerPartyId] = await Promise.all([
      data.productId
        ? productShortcodes.one(ctx.db, data.productId)
        : undefined,
      data.locationId
        ? locationShortcodes.one(ctx.db, data.locationId)
        : undefined,
      resolveOptionalOwner(ctx.db, data.ownerLedgerPartyId),
    ]);
    return {
      output: await updateInventoryEntry(
        ctx.db,
        entityId,
        { ...data, productId, locationId, ownerLedgerPartyId },
        ctx.actorContext,
      ),
      entityId,
    };
  },
  delete: async (ctx, shortcodes) => {
    const ids = await inventoryShortcodes.all(ctx.db, shortcodes);
    await deleteInventoryEntries(ctx.db, ids, ctx.actorContext);
    await runMutationSideEffectsForEntities(
      ctx.db,
      mutationEvents("inventory", "deleted", ids, "inventory.delete"),
    );
  },
});
