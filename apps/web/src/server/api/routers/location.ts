/**
 * Location Router - Direct repo access
 *
 * This entity does not require external API enrichment (e.g., USDA),
 * so it calls repo functions directly without a service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import { type LocationId, locationId } from "@cubby/schemas/identifiers";
import {
  infLocation,
  infLocationListOut,
  locationChildCountsOut,
  locationCreateInput,
  locationFiltersSchema,
  locationIdInput,
  locationIdsInput,
  locationListItemOut,
  locationShortcodeInput,
  locationShortcodesInput,
  locationSortableFields,
  locationsWithParentNameOut,
  locationTypeCountsOut,
  locationUpdateData,
  recentlyActiveLocationsInput,
  recentlyActiveLocationsOut,
  recomputeLocationValuationsOut,
  touchLastBulkInventoryOut,
} from "@cubby/schemas/location";
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
  touchLastBulkInventory as touchLastBulkInventoryRepo,
  updateLocation,
  updateLocationAiDescription,
} from "~/server/repo/location";
import { describeLocation } from "~/server/services/ai-enrichment.service";
import {
  createDeleteProcedure,
  createEntityCrudWithoutListProcedures,
  createEntityListProcedure,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Create standardized list procedure using factory
const { list } = createEntityListProcedure({
  schemas: {
    output: locationListItemOut,
    filters: locationFiltersSchema,
    sort: { sortableFields: locationSortableFields, defaultSort: "createdAt" },
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
const { getByID, create, update } = createEntityCrudWithoutListProcedures({
  schemas: {
    createInput: locationCreateInput,
    updateInput: locationUpdateData,
    output: infLocation,
    idSchema: locationId,
  },
  repository: {
    getByID: async (services, id: LocationId) => {
      return await getLocationById(services.db, id);
    },
    create: async (services, data) => {
      return await createLocation(services.db, data, services.actorContext);
    },
    update: async (services, id: LocationId, data) => {
      const previousParent = Object.hasOwn(data, "parentId")
        ? ((await getLocationById(services.db, id)).parent?.id ?? null)
        : undefined;
      const imagesChanged =
        (data.pendingImageIds?.length ?? 0) > 0 ||
        (data.removeImageIds?.length ?? 0) > 0;
      const updated = await updateLocation(
        services.db,
        id,
        data,
        services.actorContext,
      );
      // Re-parenting moves a subtree, changing ancestors' rolled-up totals.
      if (
        previousParent !== undefined &&
        previousParent !== (updated.parent?.id ?? null)
      ) {
        await services.services.locationValuation.recompute();
      }
      if (!imagesChanged) return updated;

      if (updated.images.length === 0) {
        await updateLocationAiDescription(services.db, id, null);
      } else {
        await describeLocation(services.db, id);
      }

      return await getLocationById(services.db, id);
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

const ensureGlobalUnknown = protectedProcedure
  .output(infLocation)
  .mutation(async ({ ctx }) =>
    ensureGlobalUnknownLocation(ctx.db, ctx.actorContext),
  );

// Touch lastBulkInventory timestamp (for Scanner page "Mark Complete" button)
const touchLastBulkInventory = protectedProcedure
  .input(locationIdInput)
  .output(touchLastBulkInventoryOut)
  .mutation(async ({ ctx, input }) => {
    await touchLastBulkInventoryRepo(ctx.db, input.id);
    return { success: true };
  });

// Batch lookup: multiple locations by shortcode (e.g. for label printing)
const getByShortcodes = protectedProcedure
  .input(locationShortcodesInput)
  .output(locationsWithParentNameOut)
  .query(async ({ ctx, input }) => {
    return await getLocationsByShortcodes(ctx.db, input.shortcodes);
  });

// Get location by shortcode (e.g., L-A3F2)
const getByShortcode = protectedProcedure
  .input(locationShortcodeInput)
  .output(infLocation.nullable())
  .query(async ({ ctx, input }) => {
    return await getLocationByShortcode(ctx.db, input.shortcode);
  });

// Get recently active locations for scanner quick-select
const getRecentlyActive = protectedProcedure
  .input(recentlyActiveLocationsInput)
  .output(recentlyActiveLocationsOut)
  .query(async ({ ctx, input }) => {
    return await getRecentlyActiveLocations(ctx.db, input?.limit ?? 5);
  });

// Delete procedure using standalone factory
const deleteItem = createDeleteProcedure<LocationId>(async (services, ids) => {
  await deleteLocations(services.db, ids, services.actorContext);
  await services.services.locationValuation.recompute();
}, locationId);

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
    return await getChildCountsByLocationIds(ctx.db, input.locationIds);
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
  ensureGlobalUnknown,
  create,
  update,
  recomputeValuations,
  delete: deleteItem,
  touchLastBulkInventory,
});
