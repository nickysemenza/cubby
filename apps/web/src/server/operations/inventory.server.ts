import { EMPTY_MUTATION_SIDE_EFFECTS } from "@cubby/schemas/background-jobs";
import type { ActorContext } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import {
  type EntityId,
  parseEntityId,
  parseEntityRef,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import {
  bulkMovePayload,
  inventoryBulkAddPayload,
  inventoryBulkDiscardPayload,
  inventoryFindDuplicatesInput,
  inventoryLocationIdsInput,
  inventoryLocationSnapshotInput,
  moveInventoryEntriesPayload,
  reconcileSessionPayload,
} from "@cubby/schemas/inventory";
import {
  confirmInventoryOwnershipInput,
  type InventoryOwnershipSelection,
  setInventoryOwnershipInput,
} from "@cubby/schemas/inventory-ownership";
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
  getInventoryByLocationIds,
  getInventoryLocationSnapshotToken,
  moveInventoryEntries,
  reconcileLocationSession,
  setInventoryOwnership,
  confirmInventoryOwnership,
} from "~/server/repo/inventory";
import {
  discardFromInventoryEntries,
  findDuplicateUniqueProducts,
} from "~/server/repo/product";
import {
  bindShortcodeResolver,
  lookupShortcodes,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
import { recomputeRecipesForPriceAffectedProducts } from "~/server/services/expense-pricing.service";
import {
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import type { RecipeCostingService } from "~/server/services/recipe-costing.service";
import {
  resolveScanStrays as resolveScanStraysService,
  scanAtLocation as scanAtLocationService,
} from "~/server/services/scan-into-location.service";
import {
  bindWorkflow,
  defineWorkflowOperation,
  workflow,
} from "~/server/workflow-runtime";

type InventoryMutationContext = { db: Database; actorContext: ActorContext };
const inventoryMutation = <
  Input,
  Resolved,
  Result extends { items: { id: string }[] },
>(
  name: string,
  resolve: (db: Database, input: Input) => Promise<Resolved>,
  write: (
    db: Database,
    actorContext: ActorContext,
    input: Input,
    resolved: Resolved,
  ) => Promise<Result>,
) =>
  bindWorkflow(
    workflow<InventoryMutationContext, Input>(name)
      .call("resolved", async ({ context }, { input }) =>
        resolve(context.db, input),
      )
      .commit("written", async ({ context }, { input, resolved }) =>
        write(context.db, context.actorContext, input, resolved),
      )
      .effect("entityIds", async ({ context }, { written }) =>
        inventoryShortcodes.all(
          context.db,
          written.items.map((item) => item.id),
        ),
      )
      .effect("sideEffectsRun", async ({ context }, { entityIds }) =>
        runMutationSideEffectsForEntities(
          context.db,
          mutationEvents("inventory", "updated", entityIds, name),
        ),
      )
      .output(({ written }) => ({
        ...written,
        sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
      })),
    (db: Database, actorContext: ActorContext, input: Input) => ({
      context: { db, actorContext },
      input,
    }),
  );

const locationShortcodes = bindShortcodeResolver("location");
const inventoryShortcodes = bindShortcodeResolver("inventory");
const ledgerPartyShortcodes = bindShortcodeResolver("ledgerParty");

const resolveOwnership = async (
  db: Database,
  ownership: InventoryOwnershipSelection | undefined,
) => {
  if (!ownership) return undefined;
  return {
    ownershipMode: ownership.mode,
    ownerLedgerPartyId:
      ownership.mode === "person"
        ? await ledgerPartyShortcodes.one(db, ownership.ownerId)
        : null,
  };
};

const inventoryCodesForIds = async (
  db: Database,
  ids: EntityId<"inventory">[],
) => {
  const codes = await lookupShortcodes(
    db,
    ids.map((id) => parseEntityRef("inventory", id)),
  );
  return ids.map((id) =>
    parseShortcodeFor(
      "inventory",
      codes.get(entityRefKey("inventory", id)) ?? "",
    ),
  );
};

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

/**
 * Additive: only creates or sums into the rows its own items name, and never
 * touches anything else at the location.
 */
export const bulkAddInventoryWorkflow = inventoryMutation(
  "inventory.bulkAdd",
  async (db: Database, input: z.output<typeof inventoryBulkAddPayload>) => {
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

    const resolvedOwnership = await Promise.all(
      input.items.map((item) => resolveOwnership(db, item.ownership)),
    );
    return { resolvedProducts, resolvedLocations, resolvedOwnership };
  },
  async (
    db,
    actorContext,
    input,
    { resolvedProducts, resolvedLocations, resolvedOwnership },
  ) => {
    const { items, createdCount, mergedCount } = await addInventoryEntries(
      db,
      {
        locationId: parseEntityId(
          "location",
          resolvedLocations.get(input.locationId)!,
        ),
        items: input.items.map((item, index) => ({
          productId: parseEntityId(
            "product",
            resolvedProducts.get(item.productId) ?? "",
          ),
          amount: item.amount,
          placement: item.placement,
          ownership: resolvedOwnership[index],
        })),
      },
      actorContext,
    );

    return { items, createdCount, mergedCount };
  },
);

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
type DiscardContext = InventoryMutationContext & {
  services: { recipeCosting: RecipeCostingService };
};
export const bulkDiscardInventoryWorkflow = bindWorkflow(
  workflow<DiscardContext, z.output<typeof inventoryBulkDiscardPayload>>(
    "inventory.bulkDiscard",
  )
    .call("resolvedEntries", async ({ context }, { input }) => {
      const resolvedEntries = await resolveEntityIds(
        context.db,
        input.items.map((item) => item.inventoryEntryId),
        "inventory",
      );

      return resolvedEntries;
    })
    .commit("result", async ({ context }, { input, resolvedEntries }) => {
      return await discardFromInventoryEntries(
        context.db,
        {
          items: input.items.map((item) => ({
            inventoryEntryId: parseEntityId(
              "inventory",
              resolvedEntries.get(item.inventoryEntryId)!,
            ),
            quantity: item.quantity,
          })),
          trade: input.trade,
          date: input.date,
          reason: input.reason,
        },
        context.actorContext,
      );
    })
    .effect("sideEffectsRun", async ({ context }, { result }) => {
      await runMutationSideEffectsForEntities(
        context.db,
        result.items.flatMap((line) => [
          ...mutationEvents(
            "expense",
            "created",
            [line.expenseId],
            "inventory.bulkDiscard",
          ),
          // An entry that emptied was soft-deleted; one that was drawn down was
          // updated. Reporting the wrong one leaves a removed row in the search
          // index.
          ...(line.inventory
            ? mutationEvents(
                "inventory",
                line.inventory.removed ? "deleted" : "updated",
                [line.inventory.entryId],
                "inventory.bulkDiscard",
              )
            : []),
        ]),
      );
      await recomputeRecipesForPriceAffectedProducts(
        context.db,
        context.services.recipeCosting,
        result.priceAffectedProductIds,
        "inventory.bulkDiscard",
      );
    })
    .output(({ result }) => ({
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
      sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
    })),
  (
    context: DiscardContext,
    input: z.output<typeof inventoryBulkDiscardPayload>,
  ) => ({ context, input }),
);

export const bulkMoveInventoryWorkflow = inventoryMutation(
  "inventory.bulkMove",
  async (db: Database, input: z.output<typeof bulkMovePayload>) => {
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

    return { resolvedLocations, resolvedInventories };
  },
  async (
    db,
    actorContext,
    input,
    { resolvedLocations, resolvedInventories },
  ) => {
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
    return { items };
  },
);

export const moveInventoryEntriesWorkflow = inventoryMutation(
  "inventory.moveEntries",
  async (db: Database, input: z.output<typeof moveInventoryEntriesPayload>) => {
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

    return { resolvedLocations, resolvedInventories };
  },
  async (
    db,
    actorContext,
    input,
    { resolvedLocations, resolvedInventories },
  ) => {
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
    return { items };
  },
);

export const reconcileInventorySessionWorkflow = bindWorkflow(
  workflow<InventoryMutationContext, z.output<typeof reconcileSessionPayload>>(
    "inventory.reconcileSession",
  )
    .call("resolvedInput", async ({ context: { db } }, { input }) => {
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
        snapshotToken: input.snapshotToken,
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
      return resolvedInput;
    })
    .commit(
      "result",
      async ({ context: { db, actorContext } }, { resolvedInput }) => {
        return await reconcileLocationSession(db, resolvedInput, actorContext);
      },
    )
    .effect(
      "survivingEntityIds",
      async ({ context: { db } }, { result: { items } }) => {
        return await inventoryShortcodes.all(
          db,
          items.map((entry) => entry.id),
        );
      },
    )
    .effect(
      "sideEffectsRun",
      async (
        { context: { db } },
        { result: { removedIds, recomputeNeeded }, survivingEntityIds },
      ) => {
        if (!recomputeNeeded) return;
        await runMutationSideEffectsForEntities(db, [
          ...mutationEvents(
            "inventory",
            "updated",
            survivingEntityIds,
            "inventory.reconcileSession",
          ),
          ...mutationEvents(
            "inventory",
            "deleted",
            removedIds,
            "inventory.reconcileSession",
          ),
        ]);
      },
    )
    .output(({ result: { items } }) => ({
      items,
      sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
    })),
  (
    db: Database,
    actorContext: ActorContext,
    input: z.output<typeof reconcileSessionPayload>,
  ) => ({ context: { db, actorContext }, input }),
);

export const findInventoryDuplicatesWorkflow = bindWorkflow(
  workflow<Database, z.output<typeof inventoryFindDuplicatesInput>>(
    "inventory.findDuplicates",
  )
    .call("excludeLocationId", async ({ context }, { input }) =>
      input.excludeLocationId
        ? locationShortcodes.one(context, input.excludeLocationId)
        : undefined,
    )
    .call("duplicates", async ({ context }, { excludeLocationId }) =>
      findDuplicateUniqueProducts(context, { excludeLocationId }),
    )
    .output(({ duplicates }) =>
      duplicates.map((product) => ({
        id: parseShortcodeFor("product", product.shortcode),
        name: product.name,
        manufacturer: product.manufacturer,
        expectedQuantity: product.expectedQuantity,
        locations: product.inventoryEntry.map((entry) => ({
          id: parseShortcodeFor("location", entry.location.shortcode),
          name: entry.location.name,
        })),
      })),
    ),
  (db: Database, input: z.output<typeof inventoryFindDuplicatesInput>) => ({
    context: db,
    input,
  }),
);
export const getInventoryByLocationIdsWorkflow = bindWorkflow(
  workflow<Database, z.output<typeof inventoryLocationIdsInput>>(
    "inventory.getByLocationIds",
  )
    .call("resolved", async ({ context }, { input }) =>
      resolveEntityIds(context, input.locationIds, "location"),
    )
    .call("inventory", async ({ context }, { input, resolved }) =>
      getInventoryByLocationIds(
        context,
        input.locationIds.map((shortcode) =>
          parseEntityId("location", resolved.get(shortcode)!),
        ),
        { placement: input.placement },
      ),
    )
    .output(({ inventory }) => inventory),
  (db: Database, input: z.output<typeof inventoryLocationIdsInput>) => ({
    context: db,
    input,
  }),
);

export const getInventoryLocationSnapshotWorkflow = defineWorkflowOperation(
  "inventory.locationSnapshot",
  async (
    db: Database,
    input: z.output<typeof inventoryLocationSnapshotInput>,
  ) => {
    const locationId = await locationShortcodes.one(db, input.locationId);
    // Token first: a write after this read makes the token stale and the
    // eventual destructive reconcile refuse; reversing the reads could hand a
    // caller a current token for rows absent from its visible snapshot.
    const snapshotToken = await getInventoryLocationSnapshotToken(
      db,
      locationId,
      input.placement,
    );
    const items = await getInventoryByLocationIds(db, [locationId], {
      placement: input.placement,
    });
    return { items, snapshotToken };
  },
);

export const setInventoryOwnershipWorkflow = defineWorkflowOperation(
  "inventory.setOwnership",
  async (
    context: InventoryMutationContext,
    input: z.output<typeof setInventoryOwnershipInput>,
  ) => {
    const id = await inventoryShortcodes.one(
      context.db,
      input.inventoryEntryId,
    );
    const ids = await setInventoryOwnership(
      context.db,
      id,
      input.ownership,
      input.quantity,
      context.actorContext,
    );
    await runMutationSideEffectsForEntities(
      context.db,
      mutationEvents("inventory", "updated", ids, "inventory.setOwnership"),
    );
    return { entries: await inventoryCodesForIds(context.db, ids) };
  },
);

export const confirmInventoryOwnershipWorkflow = defineWorkflowOperation(
  "inventory.confirmOwnership",
  async (
    context: InventoryMutationContext,
    input: z.output<typeof confirmInventoryOwnershipInput>,
  ) => {
    const id = await inventoryShortcodes.one(
      context.db,
      input.inventoryEntryId,
    );
    const ids = await confirmInventoryOwnership(
      context.db,
      id,
      input.evidenceFingerprint,
      input.quantity,
      context.actorContext,
    );
    await runMutationSideEffectsForEntities(
      context.db,
      mutationEvents("inventory", "updated", ids, "inventory.confirmOwnership"),
    );
    return { entries: await inventoryCodesForIds(context.db, ids) };
  },
);

export const scanInventoryAtLocationWorkflow = defineWorkflowOperation(
  "inventory.scanAtLocation",
  async (
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
    ),
);

export const resolveInventoryScanStraysWorkflow = defineWorkflowOperation(
  "inventory.resolveScanStrays",
  async (
    db: Database,
    actorContext: ActorContext,
    input: z.output<typeof resolveScanStraysInput>,
  ) => await resolveScanStraysService(db, input, actorContext),
);
