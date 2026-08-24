/**
 * Inventory Router - Direct repo access
 *
 * Inventory entries do not require external API enrichment (e.g., USDA),
 * so they call repo functions directly without a service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import {
  type InventoryShortcode,
  inventoryShortcode,
  unsafeInventoryId,
  unsafeLocationId,
  unsafeLocationShortcode,
  unsafeProductId,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import {
  bulkMovePayload,
  inventoryBulkOperationPayload,
  inventoryCountsByLocationOut,
  inventoryCreatePayloadData,
  inventoryDuplicateUniqueProductsOut,
  inventoryFiltersSchema,
  inventoryFindDuplicatesInput,
  inventoryListItemOut,
  inventoryLocationIdsInput,
  inventorySortableFields,
  inventoryUpdatePayloadData,
  inventoryWithLocationAndProductAndSideEffectsOut,
  inventoryWithLocationAndProductListAndSideEffectsOut,
  inventoryWithLocationAndProductListOut,
  inventoryWithLocationAndProductOut,
  moveInventoryEntriesPayload,
  reconcileSessionPayload,
} from "@cubby/schemas/inventory";
import {
  resolveScanStraysInput,
  resolveScanStraysOut,
  scanAtLocationInput,
  scanAtLocationOut,
} from "@cubby/schemas/scan";
import { uniq } from "es-toolkit";
import { match } from "ts-pattern";
import { createAppError } from "~/server/errors/app-error";
import {
  bulkMoveInventoryEntries,
  bulkProcessInventoryEntries,
  checkUniqueProductDuplicate,
  createInventoryEntry,
  deleteInventoryEntries,
  getInventoryByLocationIds,
  getInventoryCountsByLocations,
  getInventoryEntryByShortcode,
  inventoryentryList,
  moveInventoryEntries,
  reconcileLocationSession,
  updateInventoryEntry,
} from "~/server/repo/inventory";
import { findDuplicateUniqueProducts } from "~/server/repo/product";
import {
  bindShortcodeResolver,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import {
  resolveScanStrays as resolveScanStraysService,
  scanAtLocation as scanAtLocationService,
} from "~/server/services/scan-into-location.service";
import {
  createBulkUpdatedMutation,
  createDeleteProcedure,
  createEntityCrudWithoutListProcedures,
  createEntityListProcedure,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const productShortcodes = bindShortcodeResolver("product");
const locationShortcodes = bindShortcodeResolver("location");
const inventoryShortcodes = bindShortcodeResolver("inventory");

async function resolveEntityIds<T extends string>(
  db: Parameters<typeof resolveLiveShortcodes>[0],
  shortcodes: T[],
  entity: "inventory" | "location",
): Promise<Map<T, string>> {
  const resolved = await resolveLiveShortcodes(db, shortcodes, entity);
  // List every missing code, not just the first — matches
  // resolveAllOrThrow's documented rejection of throw-on-first, and this
  // file's own `bulkProcess` handler does the same for products.
  const missing = uniq(
    shortcodes.filter((shortcode) => !resolved.has(shortcode)),
  );
  if (missing.length > 0) {
    throw createAppError(
      entity === "inventory" ? "INVENTORY_NOT_FOUND" : "LOCATION_NOT_FOUND",
      `${entity === "inventory" ? "Inventory entry" : "Location"}(s) not found: ${missing.join(", ")}`,
    );
  }
  return resolved as Map<T, string>;
}

const { list } = createEntityListProcedure({
  schemas: {
    output: inventoryListItemOut,
    filters: inventoryFiltersSchema,
    sort: {
      sortableFields: inventorySortableFields,
      defaultSort: "createdAt",
    },
  },
  repository: {
    list: async (services, filters, sort, pagination) => {
      // The repo resolves `locationIdFilter`/`productIdFilter` itself — a
      // browse filter naming a dead code narrows to nothing rather than 404ing
      // the page, which `resolveOrThrow` here could not express.
      return await inventoryentryList(services.db, filters, sort, pagination);
    },
  },
  entityName: "inventory",
});

const { getByID, getByShortcode, create, update } =
  createEntityCrudWithoutListProcedures({
    entityName: "inventory",
    schemas: {
      createInput: inventoryCreatePayloadData,
      updateInput: inventoryUpdatePayloadData,
      output: inventoryWithLocationAndProductOut,
      createOutput: inventoryWithLocationAndProductAndSideEffectsOut,
      updateOutput: inventoryWithLocationAndProductAndSideEffectsOut,
      idSchema: inventoryShortcode,
    },
    repository: {
      getByShortcode: (services, shortcode) =>
        getInventoryEntryByShortcode(services.db, shortcode),
      create: async (services, data) => {
        const [productId, locationId] = await Promise.all([
          productShortcodes.one(services.db, data.productId),
          locationShortcodes.one(services.db, data.locationId),
        ]);
        // Check if this is a unique product that already exists elsewhere
        const duplicate = await checkUniqueProductDuplicate(
          services.db,
          productId,
          locationId,
        );

        if (duplicate) {
          throw createAppError(
            "PRODUCT_ALREADY_EXISTS",
            `This unique item "${duplicate.productName}" is already inventoried at "${duplicate.locationName}". Please update the existing entry instead of creating a duplicate.`,
          );
        }

        const created = await createInventoryEntry(
          services.db,
          { ...data, productId, locationId },
          services.actorContext,
        );
        const entityId = await inventoryShortcodes.one(services.db, created.id);
        const backgroundBatches = await runMutationSideEffects(services.db, {
          action: "created",
          entity: { entityType: "inventory", entityId },
          source: "inventory.create",
        });
        return { ...created, sideEffects: { backgroundBatches } };
      },
      update: async (services, shortcode: InventoryShortcode, data) => {
        const id = await inventoryShortcodes.one(services.db, shortcode);
        const productId = data.productId
          ? await productShortcodes.one(services.db, data.productId)
          : undefined;
        const locationId = data.locationId
          ? await locationShortcodes.one(services.db, data.locationId)
          : undefined;
        const updated = await updateInventoryEntry(
          services.db,
          id,
          { ...data, productId, locationId },
          services.actorContext,
        );
        const backgroundBatches = await runMutationSideEffects(services.db, {
          action: "updated",
          entity: { entityType: "inventory", entityId: id },
          source: "inventory.update",
        });
        return { ...updated, sideEffects: { backgroundBatches } };
      },
    },
  });

const deleteItem = createDeleteProcedure<InventoryShortcode>(
  async (services, shortcodes) => {
    const ids = await inventoryShortcodes.all(services.db, shortcodes);
    const { deleted } = await deleteInventoryEntries(
      services.db,
      ids,
      services.actorContext,
    );
    const backgroundBatches = await runMutationSideEffectsForEntities(
      services.db,
      ids.map((id) => ({
        action: "deleted" as const,
        entity: { entityType: "inventory" as const, entityId: id },
        source: "inventory.delete",
      })),
    );
    return { deleted, backgroundBatches };
  },
  inventoryShortcode,
);

// Bulk process inventory entries (creates and updates in one call)
const bulkProcess = createBulkUpdatedMutation({
  input: inventoryBulkOperationPayload,
  itemOutput: inventoryWithLocationAndProductOut,
  entity: "inventory",
  source: "inventory.bulkProcess",
  mutate: async (ctx, input) => {
    const productShortcodes = uniq(input.items.map((i) => i.productId));
    const resolvedProducts = await resolveLiveShortcodes(
      ctx.db,
      productShortcodes,
      "product",
    );
    const missing = productShortcodes.filter(
      (shortcode) => !resolvedProducts.has(shortcode),
    );
    if (missing.length > 0) {
      throw createAppError(
        "PRODUCT_NOT_FOUND",
        `Product(s) not found: ${missing.join(", ")}`,
      );
    }
    const locationShortcodes = [
      input.locationId,
      ...input.items.map((item) => item.locationId),
    ];
    const inventoryShortcodes = input.items.flatMap((item) =>
      item.id ? [item.id] : [],
    );
    const [resolvedLocations, resolvedInventories] = await Promise.all([
      resolveEntityIds(ctx.db, locationShortcodes, "location"),
      resolveEntityIds(ctx.db, inventoryShortcodes, "inventory"),
    ]);
    const locationId = unsafeLocationId(
      resolvedLocations.get(input.locationId)!,
    );
    return await bulkProcessInventoryEntries(
      ctx.db,
      locationId,
      input.items.map((item) => ({
        id: item.id
          ? unsafeInventoryId(resolvedInventories.get(item.id)!)
          : undefined,
        productId: unsafeProductId(resolvedProducts.get(item.productId) ?? ""),
        locationId: unsafeLocationId(resolvedLocations.get(item.locationId)!),
        amount: item.amount,
      })),
      ctx.actorContext,
      input.loadedAt,
    );
  },
  entityShortcodes: (items) => items.map((item) => item.id),
});

// Bulk move inventory entries between locations
const bulkMove = createBulkUpdatedMutation({
  input: bulkMovePayload,
  itemOutput: inventoryWithLocationAndProductOut,
  entity: "inventory",
  source: "inventory.bulkMove",
  mutate: async (ctx, input) => {
    const locationCodes = [input.sourceLocationId, input.targetLocationId];
    const [resolvedLocations, resolvedInventories] = await Promise.all([
      resolveEntityIds(ctx.db, locationCodes, "location"),
      resolveEntityIds(
        ctx.db,
        input.items.map((item) => item.inventoryEntryId),
        "inventory",
      ),
    ]);
    return await bulkMoveInventoryEntries(
      ctx.db,
      {
        sourceLocationId: unsafeLocationId(
          resolvedLocations.get(input.sourceLocationId)!,
        ),
        targetLocationId: unsafeLocationId(
          resolvedLocations.get(input.targetLocationId)!,
        ),
        items: input.items.map((item) => ({
          ...item,
          inventoryEntryId: unsafeInventoryId(
            resolvedInventories.get(item.inventoryEntryId)!,
          ),
        })),
      },
      ctx.actorContext,
    );
  },
  entityShortcodes: (items) => items.map((item) => item.id),
});

// Move entries to per-item destinations. The general form of a move: one call
// fans a shelf out across many drawers, or consolidates many drawers onto one
// shelf, atomically. `bulkMove` above is the one-source/one-target case.
const moveEntries = createBulkUpdatedMutation({
  input: moveInventoryEntriesPayload,
  itemOutput: inventoryWithLocationAndProductOut,
  entity: "inventory",
  source: "inventory.moveEntries",
  mutate: async (ctx, input) => {
    const [resolvedLocations, resolvedInventories] = await Promise.all([
      resolveEntityIds(
        ctx.db,
        input.items.map((item) => item.targetLocationId),
        "location",
      ),
      resolveEntityIds(
        ctx.db,
        input.items.map((item) => item.inventoryEntryId),
        "inventory",
      ),
    ]);
    return await moveInventoryEntries(
      ctx.db,
      {
        items: input.items.map((item) => ({
          inventoryEntryId: unsafeInventoryId(
            resolvedInventories.get(item.inventoryEntryId)!,
          ),
          targetLocationId: unsafeLocationId(
            resolvedLocations.get(item.targetLocationId)!,
          ),
          quantity: item.quantity,
        })),
      },
      ctx.actorContext,
    );
  },
  entityShortcodes: (items) => items.map((item) => item.id),
});

// Commit an audit-session recount: apply the staged verify/adjust/remove diff +
// stamp lastBulkInventory. Only dispatch a valuation recompute if something
// actually changed (adjust/remove) — a pure-verify commit is a free no-op.
const reconcileSession = protectedProcedure
  .input(reconcileSessionPayload)
  .output(strictOutput(inventoryWithLocationAndProductListAndSideEffectsOut))
  .mutation(async ({ ctx, input }) => {
    const inventoryCodes = [
      ...input.expectedInventoryEntryIds,
      ...input.resolutions.map((resolution) => resolution.inventoryEntryId),
    ];
    const locationCodes = [
      input.locationId,
      ...input.resolutions.flatMap((resolution) =>
        resolution.kind === "relocate" ? [resolution.targetLocationId] : [],
      ),
    ];
    const [resolvedInventories, resolvedLocations] = await Promise.all([
      resolveEntityIds(ctx.db, inventoryCodes, "inventory"),
      resolveEntityIds(ctx.db, locationCodes, "location"),
    ]);
    const resolvedInput = {
      ...input,
      locationId: unsafeLocationId(resolvedLocations.get(input.locationId)!),
      expectedInventoryEntryIds: input.expectedInventoryEntryIds.map((id) =>
        unsafeInventoryId(resolvedInventories.get(id)!),
      ),
      resolutions: input.resolutions.map((resolution) => {
        const inventoryEntryId = unsafeInventoryId(
          resolvedInventories.get(resolution.inventoryEntryId)!,
        );
        return match(resolution)
          .with({ kind: "verify" }, () => ({
            kind: "verify" as const,
            inventoryEntryId,
          }))
          .with({ kind: "adjust" }, (r) => ({
            kind: "adjust" as const,
            inventoryEntryId,
            amount: r.amount,
          }))
          .with({ kind: "remove" }, () => ({
            kind: "remove" as const,
            inventoryEntryId,
          }))
          .with({ kind: "relocate" }, (r) => ({
            kind: "relocate" as const,
            inventoryEntryId,
            targetLocationId: unsafeLocationId(
              resolvedLocations.get(r.targetLocationId)!,
            ),
          }))
          .exhaustive();
      }),
    };
    const { items, removedIds, recomputeNeeded } =
      await reconcileLocationSession(ctx.db, resolvedInput, ctx.actorContext);
    // Surviving entries get "updated" side-effects; removed (soft-deleted) ones
    // get "deleted" so their embedding is cleaned up too (they're not in items).
    const survivingEntityIds = await inventoryShortcodes.all(
      ctx.db,
      items.map((entry) => entry.id),
    );
    const backgroundBatches = recomputeNeeded
      ? await runMutationSideEffectsForEntities(ctx.db, [
          ...survivingEntityIds.map((entityId) => ({
            action: "updated" as const,
            entity: { entityType: "inventory" as const, entityId },
            source: "inventory.reconcileSession",
          })),
          ...removedIds.map((id) => ({
            action: "deleted" as const,
            entity: { entityType: "inventory" as const, entityId: id },
            source: "inventory.reconcileSession",
          })),
        ])
      : [];
    return { items, sideEffects: { backgroundBatches } };
  });

// Find products with expectedQuantity=1 in multiple locations
const findDuplicates = protectedProcedure
  .input(inventoryFindDuplicatesInput)
  .output(strictOutput(inventoryDuplicateUniqueProductsOut))
  .query(async ({ ctx, input }) => {
    const excludeLocationId = input.excludeLocationId
      ? await locationShortcodes.one(ctx.db, input.excludeLocationId)
      : undefined;
    const duplicates = await findDuplicateUniqueProducts(ctx.db, {
      excludeLocationId,
    });

    return duplicates.map((product) => ({
      id: unsafeProductShortcode(product.shortcode),
      name: product.name,
      manufacturer: product.manufacturer,
      expectedQuantity: product.expectedQuantity,
      locations: product.inventoryEntry.map((entry) => ({
        id: unsafeLocationShortcode(entry.location.shortcode),
        name: entry.location.name,
      })),
    }));
  });

// Get inventory counts for multiple locations (batched query to avoid N+1)
const getCountsByLocations = protectedProcedure
  .input(inventoryLocationIdsInput)
  .output(strictOutput(inventoryCountsByLocationOut))
  .query(async ({ ctx, input }) => {
    const resolved = await resolveEntityIds(
      ctx.db,
      input.locationIds,
      "location",
    );
    const ids = input.locationIds.map((shortcode) =>
      unsafeLocationId(resolved.get(shortcode)!),
    );
    const counts = await getInventoryCountsByLocations(ctx.db, ids);
    return Object.fromEntries(
      input.locationIds.map((shortcode, index) => [
        shortcode,
        counts[ids[index]!] ?? 0,
      ]),
    );
  });

// Get inventory entries for multiple locations (batched query to avoid N+1)
const getByLocationIds = protectedProcedure
  .input(inventoryLocationIdsInput)
  .output(strictOutput(inventoryWithLocationAndProductListOut))
  .query(async ({ ctx, input }) => {
    const resolved = await resolveEntityIds(
      ctx.db,
      input.locationIds,
      "location",
    );
    return await getInventoryByLocationIds(
      ctx.db,
      input.locationIds.map((shortcode) =>
        unsafeLocationId(resolved.get(shortcode)!),
      ),
      { placement: input.placement },
    );
  });

/**
 * One scan during a location sweep. Adds, confirms, or reports strays — see
 * `scan-into-location.service` for why the decision is server-side.
 */
const scanAtLocation = protectedProcedure
  .input(scanAtLocationInput)
  .output(strictOutput(scanAtLocationOut))
  .mutation(({ ctx, input }) =>
    scanAtLocationService(
      ctx.db,
      ctx.usdaClient,
      ctx.upcLookupClient,
      input,
      ctx.actorContext,
    ),
  );

/** Commit the strays a sweep turned up, at the end, in one move. */
const resolveScanStrays = protectedProcedure
  .input(resolveScanStraysInput)
  .output(strictOutput(resolveScanStraysOut))
  .mutation(({ ctx, input }) =>
    resolveScanStraysService(ctx.db, input, ctx.actorContext),
  );

export const inventoryRouter = createTRPCRouter({
  getByID,
  getByShortcode,
  list,
  update,
  create,
  delete: deleteItem,
  bulkProcess,
  bulkMove,
  moveEntries,
  reconcileSession,
  scanAtLocation,
  resolveScanStrays,
  findDuplicates,
  getCountsByLocations,
  getByLocationIds,
});
