import type { ActorContext } from "@cubby/schemas/context";
import {
  type EntityId,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import {
  bulkMovePayload,
  inventoryBulkAddPayload,
  inventoryBulkDiscardPayload,
  inventoryBulkOperationPayload,
  inventoryFindDuplicatesInput,
  inventoryLocationIdsInput,
  moveInventoryEntriesPayload,
  reconcileSessionPayload,
} from "@cubby/schemas/inventory";
import {
  resolveScanStraysInput,
  scanAtLocationInput,
} from "@cubby/schemas/scan";
import { uniq } from "es-toolkit";
import { match } from "ts-pattern";
import type { z } from "zod";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  addInventoryEntries,
  bulkMoveInventoryEntries,
  bulkProcessInventoryEntries,
  getInventoryByLocationIds,
  moveInventoryEntries,
  reconcileLocationSession,
} from "~/server/repo/inventory";
import {
  discardFromInventoryEntries,
  findDuplicateUniqueProducts,
} from "~/server/repo/product";
import {
  bindShortcodeResolver,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
import { recomputeRecipesForPriceAffectedProducts } from "~/server/services/expense-pricing.service";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";
import type { RecipeCostingService } from "~/server/services/recipe-costing.service";
import {
  resolveScanStrays as resolveScanStraysService,
  scanAtLocation as scanAtLocationService,
} from "~/server/services/scan-into-location.service";

export {
  bulkMovePayload,
  inventoryBulkAddPayload,
  inventoryBulkDiscardPayload,
  inventoryBulkOperationPayload,
  inventoryFindDuplicatesInput,
  inventoryLocationIdsInput,
  moveInventoryEntriesPayload,
  reconcileSessionPayload,
  resolveScanStraysInput,
  scanAtLocationInput,
};

const locationShortcodes = bindShortcodeResolver("location");
const inventoryShortcodes = bindShortcodeResolver("inventory");

async function resolveEntityIds<
  T extends string,
  E extends "inventory" | "location",
>(db: Database, shortcodes: T[], entity: E): Promise<Map<T, EntityId<E>>> {
  const resolved = await resolveLiveShortcodes(db, shortcodes, entity);
  const missing = uniq(
    shortcodes.filter((shortcode) => !resolved.has(shortcode)),
  );
  if (missing.length > 0) {
    throw createAppError(
      entity === "inventory" ? "INVENTORY_NOT_FOUND" : "LOCATION_NOT_FOUND",
      `${entity === "inventory" ? "Inventory entry" : "Location"}(s) not found: ${missing.join(", ")}`,
    );
  }
  const ids = new Map<T, EntityId<E>>();
  for (const shortcode of shortcodes) {
    const id = resolved.get(shortcode);
    if (id !== undefined) ids.set(shortcode, id);
  }
  return ids;
}

export const bulkProcessInventoryWorkflow = async (
  db: Database,
  actorContext: ActorContext,
  input: z.output<typeof inventoryBulkOperationPayload>,
) => {
  const productShortcodes = uniq(input.items.map((item) => item.productId));
  const resolvedProducts = await resolveLiveShortcodes(
    db,
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
  const [resolvedLocations, resolvedInventories] = await Promise.all([
    resolveEntityIds(
      db,
      [input.locationId, ...input.items.map((item) => item.locationId)],
      "location",
    ),
    resolveEntityIds(
      db,
      input.items.flatMap((item) => (item.id ? [item.id] : [])),
      "inventory",
    ),
  ]);
  const items = await bulkProcessInventoryEntries(
    db,
    parseEntityId("location", resolvedLocations.get(input.locationId)!),
    input.items.map((item) => ({
      id: item.id
        ? parseEntityId("inventory", resolvedInventories.get(item.id)!)
        : undefined,
      productId: parseEntityId(
        "product",
        resolvedProducts.get(item.productId) ?? "",
      ),
      locationId: parseEntityId(
        "location",
        resolvedLocations.get(item.locationId)!,
      ),
      amount: item.amount,
    })),
    actorContext,
    input.loadedAt,
  );
  const entityIds = await inventoryShortcodes.all(
    db,
    items.map((item) => item.id),
  );
  const backgroundBatches = await runMutationSideEffectsForEntities(
    db,
    entityIds.map((entityId) => ({
      action: "updated" as const,
      entity: { entityType: "inventory" as const, entityId },
      source: "inventory.bulkProcess",
    })),
  );
  return { items, sideEffects: { backgroundBatches } };
};

/**
 * Additive counterpart to {@link bulkProcessInventoryWorkflow}: only creates
 * or sums into the rows its own items name, and never touches anything else
 * at the location (that one is delete-on-omit; see `bulk.ts`).
 */
export const bulkAddInventoryWorkflow = async (
  db: Database,
  actorContext: ActorContext,
  input: z.output<typeof inventoryBulkAddPayload>,
) => {
  const productShortcodes = uniq(input.items.map((item) => item.productId));
  const resolvedProducts = await resolveLiveShortcodes(
    db,
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
  const resolvedLocations = await resolveEntityIds(
    db,
    [input.locationId],
    "location",
  );

  const { items, createdCount, mergedCount } = await addInventoryEntries(
    db,
    {
      locationId: parseEntityId(
        "location",
        resolvedLocations.get(input.locationId)!,
      ),
      items: input.items.map((item) => ({
        productId: parseEntityId(
          "product",
          resolvedProducts.get(item.productId) ?? "",
        ),
        amount: item.amount,
        placement: item.placement,
      })),
    },
    actorContext,
  );

  const entityIds = await inventoryShortcodes.all(
    db,
    items.map((item) => item.id),
  );
  const backgroundBatches = await runMutationSideEffectsForEntities(
    db,
    entityIds.map((entityId) => ({
      action: "updated" as const,
      entity: { entityType: "inventory" as const, entityId },
      source: "inventory.bulkAdd",
    })),
  );
  return {
    items,
    createdCount,
    mergedCount,
    sideEffects: { backgroundBatches },
  };
};

/**
 * Write off units from a selection of shelf rows.
 *
 * The inventory-side counterpart to `discardProductWorkflow`: that one starts
 * from a product and has to ask which shelf, this one starts from the shelf
 * rows themselves. One transaction, N ledger lines — the same shape as
 * {@link bulkAddInventoryWorkflow}, and for the same reason: a loop of
 * per-row requests gives no cross-row atomicity, which is acceptable for a
 * reversible flag and not for ledger rows.
 */
export const bulkDiscardInventoryWorkflow = async (
  context: {
    db: Database;
    actorContext: ActorContext;
    services: { recipeCosting: RecipeCostingService };
  },
  input: z.output<typeof inventoryBulkDiscardPayload>,
) => {
  const resolvedEntries = await resolveEntityIds(
    context.db,
    input.items.map((item) => item.inventoryEntryId),
    "inventory",
  );

  const result = await discardFromInventoryEntries(
    context.db,
    {
      items: input.items.map((item) => ({
        inventoryEntryId: parseEntityId(
          "inventory",
          resolvedEntries.get(item.inventoryEntryId)!,
        ),
        quantity: item.quantity,
      })),
      date: input.date,
      reason: input.reason,
    },
    context.actorContext,
  );

  const backgroundBatches = await runMutationSideEffectsForEntities(
    context.db,
    result.items.flatMap((line) => [
      {
        action: "created" as const,
        entity: { entityType: "expense" as const, entityId: line.expenseId },
        source: "inventory.bulkDiscard",
      },
      // An entry that emptied was soft-deleted; one that was drawn down was
      // updated. Reporting the wrong one leaves a removed row in the search
      // index.
      ...(line.inventory
        ? [
            {
              action: line.inventory.removed
                ? ("deleted" as const)
                : ("updated" as const),
              entity: {
                entityType: "inventory" as const,
                entityId: line.inventory.entryId,
              },
              source: "inventory.bulkDiscard",
            },
          ]
        : []),
    ]),
  );
  const recipeBatches = await recomputeRecipesForPriceAffectedProducts(
    context.db,
    context.services.recipeCosting,
    result.priceAffectedProductIds,
    "inventory.bulkDiscard",
  );

  return {
    items: result.items.map((line) => ({
      inventoryEntryId: parseShortcodeFor(
        "inventory",
        line.inventory?.entryShortcode ?? "",
      ),
      productId: line.productShortcode,
      expenseId: parseShortcodeFor("expense", line.expenseShortcode),
      storedQuantity: line.storedQuantity,
      removed: line.inventory?.removed ?? false,
      remainingValue: line.inventory?.remainingValue ?? null,
    })),
    sideEffects: {
      backgroundBatches: [...backgroundBatches, ...recipeBatches],
    },
  };
};

export const bulkMoveInventoryWorkflow = async (
  db: Database,
  actorContext: ActorContext,
  input: z.output<typeof bulkMovePayload>,
) => {
  const [resolvedLocations, resolvedInventories] = await Promise.all([
    resolveEntityIds(
      db,
      [input.sourceLocationId, input.targetLocationId],
      "location",
    ),
    resolveEntityIds(
      db,
      input.items.map((item) => item.inventoryEntryId),
      "inventory",
    ),
  ]);
  const items = await bulkMoveInventoryEntries(
    db,
    {
      sourceLocationId: parseEntityId(
        "location",
        resolvedLocations.get(input.sourceLocationId)!,
      ),
      targetLocationId: parseEntityId(
        "location",
        resolvedLocations.get(input.targetLocationId)!,
      ),
      items: input.items.map((item) => ({
        ...item,
        inventoryEntryId: parseEntityId(
          "inventory",
          resolvedInventories.get(item.inventoryEntryId)!,
        ),
      })),
    },
    actorContext,
  );
  const entityIds = await inventoryShortcodes.all(
    db,
    items.map((item) => item.id),
  );
  const backgroundBatches = await runMutationSideEffectsForEntities(
    db,
    entityIds.map((entityId) => ({
      action: "updated" as const,
      entity: { entityType: "inventory" as const, entityId },
      source: "inventory.bulkMove",
    })),
  );
  return { items, sideEffects: { backgroundBatches } };
};

export const moveInventoryEntriesWorkflow = async (
  db: Database,
  actorContext: ActorContext,
  input: z.output<typeof moveInventoryEntriesPayload>,
) => {
  const [resolvedLocations, resolvedInventories] = await Promise.all([
    resolveEntityIds(
      db,
      input.items.map((item) => item.targetLocationId),
      "location",
    ),
    resolveEntityIds(
      db,
      input.items.map((item) => item.inventoryEntryId),
      "inventory",
    ),
  ]);
  const items = await moveInventoryEntries(
    db,
    {
      items: input.items.map((item) => ({
        inventoryEntryId: parseEntityId(
          "inventory",
          resolvedInventories.get(item.inventoryEntryId)!,
        ),
        targetLocationId: parseEntityId(
          "location",
          resolvedLocations.get(item.targetLocationId)!,
        ),
        quantity: item.quantity,
      })),
    },
    actorContext,
  );
  const entityIds = await inventoryShortcodes.all(
    db,
    items.map((item) => item.id),
  );
  const backgroundBatches = await runMutationSideEffectsForEntities(
    db,
    entityIds.map((entityId) => ({
      action: "updated" as const,
      entity: { entityType: "inventory" as const, entityId },
      source: "inventory.moveEntries",
    })),
  );
  return { items, sideEffects: { backgroundBatches } };
};

export const reconcileInventorySessionWorkflow = async (
  db: Database,
  actorContext: ActorContext,
  input: z.output<typeof reconcileSessionPayload>,
) => {
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
    resolveEntityIds(db, inventoryCodes, "inventory"),
    resolveEntityIds(db, locationCodes, "location"),
  ]);
  const resolvedInput = {
    ...input,
    locationId: parseEntityId(
      "location",
      resolvedLocations.get(input.locationId)!,
    ),
    expectedInventoryEntryIds: input.expectedInventoryEntryIds.map((id) =>
      parseEntityId("inventory", resolvedInventories.get(id)!),
    ),
    resolutions: input.resolutions.map((resolution) => {
      const inventoryEntryId = parseEntityId(
        "inventory",
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
          targetLocationId: parseEntityId(
            "location",
            resolvedLocations.get(r.targetLocationId)!,
          ),
        }))
        .exhaustive();
    }),
  };
  const { items, removedIds, recomputeNeeded } = await reconcileLocationSession(
    db,
    resolvedInput,
    actorContext,
  );
  const survivingEntityIds = await inventoryShortcodes.all(
    db,
    items.map((entry) => entry.id),
  );
  const backgroundBatches = recomputeNeeded
    ? await runMutationSideEffectsForEntities(db, [
        ...survivingEntityIds.map((entityId) => ({
          action: "updated" as const,
          entity: { entityType: "inventory" as const, entityId },
          source: "inventory.reconcileSession",
        })),
        ...removedIds.map((entityId) => ({
          action: "deleted" as const,
          entity: { entityType: "inventory" as const, entityId },
          source: "inventory.reconcileSession",
        })),
      ])
    : [];
  return { items, sideEffects: { backgroundBatches } };
};

export const findInventoryDuplicatesWorkflow = async (
  db: Database,
  input: z.output<typeof inventoryFindDuplicatesInput>,
) => {
  const excludeLocationId = input.excludeLocationId
    ? await locationShortcodes.one(db, input.excludeLocationId)
    : undefined;
  const duplicates = await findDuplicateUniqueProducts(db, {
    excludeLocationId,
  });
  return duplicates.map((product) => ({
    id: parseShortcodeFor("product", product.shortcode),
    name: product.name,
    manufacturer: product.manufacturer,
    expectedQuantity: product.expectedQuantity,
    locations: product.inventoryEntry.map((entry) => ({
      id: parseShortcodeFor("location", entry.location.shortcode),
      name: entry.location.name,
    })),
  }));
};

export const getInventoryByLocationIdsWorkflow = async (
  db: Database,
  input: z.output<typeof inventoryLocationIdsInput>,
) => {
  const resolved = await resolveEntityIds(db, input.locationIds, "location");
  return await getInventoryByLocationIds(
    db,
    input.locationIds.map((shortcode) =>
      parseEntityId("location", resolved.get(shortcode)!),
    ),
    { placement: input.placement },
  );
};

export const scanInventoryAtLocationWorkflow = async (
  context: {
    db: Database;
    usdaClient: Parameters<typeof scanAtLocationService>[1];
    upcLookupClient: Parameters<typeof scanAtLocationService>[2];
    actorContext: ActorContext;
  },
  input: z.output<typeof scanAtLocationInput>,
) =>
  await scanAtLocationService(
    context.db,
    context.usdaClient,
    context.upcLookupClient,
    input,
    context.actorContext,
  );

export const resolveInventoryScanStraysWorkflow = async (
  db: Database,
  actorContext: ActorContext,
  input: z.output<typeof resolveScanStraysInput>,
) => await resolveScanStraysService(db, input, actorContext);
