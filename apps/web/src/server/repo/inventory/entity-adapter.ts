import {
  inventoryFiltersSchema,
  inventoryListItemOut,
  inventorySortableFields,
  inventoryWithLocationAndProductOut,
} from "@cubby/schemas/inventory";
import { defineEntityAdapter } from "~/server/entity-kernel/adapter";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";
import {
  checkUniqueProductDuplicate,
  createInventoryEntry,
  deleteInventoryEntries,
  getInventoryEntryByShortcode,
  INVENTORY_DELETE_EDGE_POLICY,
  inventoryentryList,
  updateInventoryEntry,
} from "./crud";

const inventoryShortcodes = bindShortcodeResolver("inventory");
const productShortcodes = bindShortcodeResolver("product");
const locationShortcodes = bindShortcodeResolver("location");

export const inventoryEntityAdapter = defineEntityAdapter({
  entity: "inventory",
  filters: inventoryFiltersSchema,
  detailOutput: inventoryWithLocationAndProductOut,
  listOutput: inventoryListItemOut,
  sort: { fields: inventorySortableFields, default: "createdAt" },
  lifecycle: { delete: INVENTORY_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getInventoryEntryByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      inventoryentryList(ctx.db, filters, sorts, pagination),
    create: async (ctx, data) => {
      const [productId, locationId] = await Promise.all([
        productShortcodes.one(ctx.db, data.productId),
        locationShortcodes.one(ctx.db, data.locationId),
      ]);
      const duplicate = await checkUniqueProductDuplicate(
        ctx.db,
        productId,
        locationId,
      );
      if (duplicate)
        throw new Error(
          `Unique product ${duplicate.productName} is already inventoried at ${duplicate.locationName}`,
        );
      const output = await createInventoryEntry(
        ctx.db,
        { ...data, productId, locationId },
        ctx.actorContext,
      );
      return {
        output,
        entityId: await inventoryShortcodes.one(ctx.db, output.id),
      };
    },
    update: async (ctx, shortcode, data) => {
      const entityId = await inventoryShortcodes.one(ctx.db, shortcode);
      const [productId, locationId] = await Promise.all([
        data.productId
          ? productShortcodes.one(ctx.db, data.productId)
          : undefined,
        data.locationId
          ? locationShortcodes.one(ctx.db, data.locationId)
          : undefined,
      ]);
      return {
        output: await updateInventoryEntry(
          ctx.db,
          entityId,
          { ...data, productId, locationId },
          ctx.actorContext,
        ),
        entityId,
      };
    },
    delete: async (ctx, shortcodes) => {
      const ids = await inventoryShortcodes.all(ctx.db, shortcodes);
      const { deleted } = await deleteInventoryEntries(
        ctx.db,
        ids,
        ctx.actorContext,
      );
      const backgroundBatches = await runMutationSideEffectsForEntities(
        ctx.db,
        ids.map((entityId) => ({
          action: "deleted" as const,
          entity: { entityType: "inventory" as const, entityId },
          source: "inventory.delete",
        })),
      );
      return { deleted, backgroundBatches };
    },
  },
});
