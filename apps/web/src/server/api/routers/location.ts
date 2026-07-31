/**
 * Location Router - Direct repo access
 *
 * This entity does not require external API enrichment (e.g., USDA),
 * so it calls repo functions directly without a service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import {
  type LocationId,
  type LocationShortcode,
  locationShortcode,
  unsafeLocationId,
} from "@cubby/schemas/identifiers";
import {
  infLocation,
  infLocationListOut,
  infLocationWithSideEffects,
  locationBulkUpdateParentInput,
  locationBulkUpdateParentOut,
  locationChildCountsOut,
  locationCreateInput,
  locationFiltersSchema,
  locationIdsInput,
  locationListItemOut,
  locationParentOptionsOut,
  locationShortcodesInput,
  locationSortableFields,
  locationsWithParentNameOut,
  locationTypeCountsOut,
  locationUpdateData,
  recentlyActiveLocationsInput,
  recentlyActiveLocationsOut,
  recomputeLocationValuationsOut,
} from "@cubby/schemas/location";
import { z } from "zod";
import { createAppError } from "~/server/errors/app-error";
import { withTransaction } from "~/server/repo/database-helpers";
import {
  buildLocationTree,
  buildLocationTypeCount,
  createLocation,
  deleteLocations,
  ensureGlobalUnknownLocation,
  getChildCountsByLocationIds,
  getLocationById,
  getLocationByShortcode,
  getLocationsByShortcodes,
  getRecentlyActiveLocations,
  locationList,
  locationParentOptions,
  updateLocation,
  updateLocationAiDescription,
} from "~/server/repo/location";
import {
  resolveLiveShortcode,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import {
  createDeleteProcedure,
  createEntityCrudWithoutListProcedures,
  createEntityListProcedure,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

async function resolveLocationId(
  db: Parameters<typeof resolveLiveShortcode>[0],
  shortcode: LocationShortcode,
): Promise<LocationId> {
  const id = await resolveLiveShortcode(db, shortcode, "location");
  if (!id) {
    throw createAppError(
      "LOCATION_NOT_FOUND",
      `Location ${shortcode} not found`,
    );
  }
  return unsafeLocationId(id);
}

async function resolveLocationIds(
  db: Parameters<typeof resolveLiveShortcodes>[0],
  shortcodes: LocationShortcode[],
): Promise<LocationId[]> {
  const resolved = await resolveLiveShortcodes(db, shortcodes, "location");
  const missing = shortcodes.find((shortcode) => !resolved.has(shortcode));
  if (missing) {
    throw createAppError("LOCATION_NOT_FOUND", `Location ${missing} not found`);
  }
  return shortcodes.map((shortcode) =>
    unsafeLocationId(resolved.get(shortcode)!),
  );
}

// Create standardized list procedure using factory
const { list } = createEntityListProcedure({
  schemas: {
    output: locationListItemOut,
    filters: locationFiltersSchema,
    sort: {
      sortableFields: locationSortableFields,
      defaultSort: "createdAt",
      // See the note in product.ts — group keys must be real columns.
      groupableFields: ["type"] as const,
    },
  },
  repository: {
    list: async (services, filters, sort, pagination, groupBy) => {
      return await locationList(
        services.db,
        filters,
        sort,
        pagination,
        groupBy,
      );
    },
  },
  entityName: "location",
});

// Create standardized getByID, create, update procedures using factory
const { getByID, getByShortcode, create, update } =
  createEntityCrudWithoutListProcedures({
    entityName: "location",
    schemas: {
      createInput: locationCreateInput,
      updateInput: locationUpdateData,
      output: infLocation,
      createOutput: infLocationWithSideEffects,
      updateOutput: infLocationWithSideEffects,
      idSchema: locationShortcode,
    },
    repository: {
      getByID: async (services, shortcode: LocationShortcode) => {
        const id = await resolveLocationId(services.db, shortcode);
        return await getLocationById(services.db, id);
      },
      getByShortcode: (services, shortcode) =>
        getLocationByShortcode(services.db, shortcode),
      create: async (services, data) => {
        const location = await createLocation(
          services.db,
          data,
          services.actorContext,
        );
        const entityId = await resolveLocationId(services.db, location.id);
        const backgroundBatches = await runMutationSideEffects(services.db, {
          action: "created",
          entity: { entityType: "location", entityId },
          source: "location.create",
          // A location created WITH photos must trigger the AI description /
          // inventory refresh too — without this it's born with a NULL description
          // (only location.update was setting the flag).
          locationImagesChanged: (data.pendingImageIds?.length ?? 0) > 0,
        });
        return { ...location, sideEffects: { backgroundBatches } };
      },
      update: async (services, shortcode: LocationShortcode, data) => {
        const id = await resolveLocationId(services.db, shortcode);
        const imagesChanged =
          (data.pendingImageIds?.length ?? 0) > 0 ||
          (data.removeImageIds?.length ?? 0) > 0;
        const updated = await updateLocation(
          services.db,
          id,
          data,
          services.actorContext,
        );
        const backgroundBatches = await runMutationSideEffects(services.db, {
          action: "updated",
          entity: { entityType: "location", entityId: id },
          source: "location.update",
          locationImagesChanged: imagesChanged,
        });
        if (!imagesChanged) {
          return { ...updated, sideEffects: { backgroundBatches } };
        }

        if (updated.images.length === 0) {
          await updateLocationAiDescription(services.db, id, null);
        }

        const refreshed = await getLocationById(services.db, id);
        return { ...refreshed, sideEffects: { backgroundBatches } };
      },
    },
  });

const getLocationTypesCount = protectedProcedure
  .output(locationTypeCountsOut)
  .query(async ({ ctx }) => {
    return await buildLocationTypeCount(ctx.db);
  });

const makeTree = protectedProcedure
  .output(infLocationListOut)
  .query(async ({ ctx }) => await buildLocationTree(ctx.db));

/**
 * Lightweight `{id, name}` options for the location filter's parent picklist
 * (see `useLocationParentOptions`) — only locations with at least one live
 * child, not the full location roster (see repo/location/lookup.ts's
 * `locationParentOptions`). Mirrors `project.options`' role/shape.
 */
const parentOptions = protectedProcedure
  .output(z.array(locationParentOptionsOut))
  .query(({ ctx }) => locationParentOptions(ctx.db));

const ensureGlobalUnknown = protectedProcedure
  .output(infLocation)
  .mutation(async ({ ctx }) => {
    const location = await ensureGlobalUnknownLocation(
      ctx.db,
      ctx.actorContext,
    );
    const entityId = await resolveLocationId(ctx.db, location.id);
    await runMutationSideEffects(ctx.db, {
      action: "updated",
      entity: { entityType: "location", entityId },
      source: "location.ensureGlobalUnknown",
    });
    return location;
  });

const bulkUpdateParent = protectedProcedure
  .input(locationBulkUpdateParentInput)
  .output(locationBulkUpdateParentOut)
  .mutation(async ({ ctx, input }) => {
    if (input.parentId && input.ids.includes(input.parentId)) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Cannot move a location under itself.",
      );
    }

    const ids = await resolveLocationIds(ctx.db, input.ids);
    const parentId = input.parentId
      ? await resolveLocationId(ctx.db, input.parentId)
      : null;

    await withTransaction(ctx.db, async (tx) => {
      for (const id of ids) {
        await updateLocation(
          tx,
          id,
          { parentId: input.parentId },
          ctx.actorContext,
          { resolvedParentId: parentId },
        );
      }
    });

    await runMutationSideEffectsForEntities(
      ctx.db,
      ids.map((id) => ({
        action: "updated" as const,
        entity: { entityType: "location" as const, entityId: id },
        source: "location.bulkUpdateParent",
      })),
    );
    return { updated: input.ids.length };
  });

// Batch lookup: multiple locations by shortcode (e.g. for label printing)
const getByShortcodes = protectedProcedure
  .input(locationShortcodesInput)
  .output(locationsWithParentNameOut)
  .query(async ({ ctx, input }) => {
    return await getLocationsByShortcodes(ctx.db, input.shortcodes);
  });

// Get recently active locations for scanner quick-select
const getRecentlyActive = protectedProcedure
  .input(recentlyActiveLocationsInput)
  .output(recentlyActiveLocationsOut)
  .query(async ({ ctx, input }) => {
    return await getRecentlyActiveLocations(ctx.db, input?.limit ?? 5);
  });

// Delete procedure using standalone factory
const deleteItem = createDeleteProcedure<LocationShortcode>(
  async (services, shortcodes) => {
    const ids = await resolveLocationIds(services.db, shortcodes);
    await deleteLocations(services.db, ids, services.actorContext);
    return await runMutationSideEffectsForEntities(
      services.db,
      ids.map((id) => ({
        action: "deleted" as const,
        entity: { entityType: "location" as const, entityId: id },
        source: "location.delete",
      })),
    );
  },
  locationShortcode,
);

// Manual whole-tree recompute of persisted location valuations. Used to populate
// after the column is first added, and as a safety net for writes that bypass the
// router (raw SQL / postgres MCP). Idempotent — same inventory → same numbers.
const recomputeValuations = protectedProcedure
  .output(recomputeLocationValuationsOut)
  .mutation(async ({ ctx }) => {
    const updated = await ctx.services.locationValuation.recompute();
    return { updated };
  });

// Get child location counts for multiple parent locations (batched to avoid N+1)
const getChildCountsByLocations = protectedProcedure
  .input(locationIdsInput)
  .output(locationChildCountsOut)
  .query(async ({ ctx, input }) => {
    const ids = await resolveLocationIds(ctx.db, input.locationIds);
    const counts = await getChildCountsByLocationIds(ctx.db, ids);
    return Object.fromEntries(
      input.locationIds.map((shortcode, index) => [
        shortcode,
        counts[ids[index]!] ?? 0,
      ]),
    );
  });

export const locationRouter = createTRPCRouter({
  list,
  getByID,
  getByShortcode,
  getByShortcodes,
  getRecentlyActive,
  getLocationTypesCount,
  getChildCountsByLocations,
  makeTree,
  parentOptions,
  ensureGlobalUnknown,
  create,
  update,
  recomputeValuations,
  delete: deleteItem,
  bulkUpdateParent,
});
