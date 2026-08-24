/**
 * Location Router - Direct repo access
 *
 * This entity does not require external API enrichment (e.g., USDA),
 * so it calls repo functions directly without a service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import { locationShortcode } from "@cubby/schemas/identifiers";
import {
  infLocation,
  infLocationListOut,
  locationBulkUpdateParentInput,
  locationBulkUpdateParentOut,
  locationFiltersSchema,
  locationInventoryBreakdownOut,
  locationListItemOut,
  locationOptionItemOut,
  locationParentOptionsOut,
  locationPickerItemOut,
  locationPickerSortableFields,
  locationShortcodesInput,
  locationsWithParentNameOut,
  locationValuationSummaryOut,
  recomputeLocationValuationsOut,
} from "@cubby/schemas/location";
import { uniq } from "es-toolkit";
import { z } from "zod";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
import { createAppError } from "~/server/errors/app-error";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import {
  buildLocationTree,
  bulkReparentLocations,
  ensureGlobalUnknownLocation,
  getLocationByShortcode,
  getLocationInventoryBreakdown,
  getLocationsByShortcodes,
  getLocationValuationSummary,
  locationOptions,
  locationParentOptions,
  locationSearch,
} from "~/server/repo/location";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import { createEntityListProcedure } from "../crud-factory";
import { createEntityCompatibilityProcedures } from "../entity-compatibility";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const locationShortcodes = bindShortcodeResolver("location");

const {
  list,
  create,
  update,
  delete: deleteItem,
} = createEntityCompatibilityProcedures(ENTITY_KERNEL_BINDINGS.location, {
  ...ENTITY_BINDINGS.location.crud,
  listOutput: locationListItemOut,
});

// Location detail carries tree and image relations that do not belong in the
// baseline entity record.
const getByID = protectedProcedure
  .input(z.object({ id: locationShortcode }))
  .output(strictOutput(infLocation))
  .query(async ({ ctx, input }) => {
    const location = await getLocationByShortcode(ctx.db, input.id);
    if (!location)
      throw createAppError(
        "LOCATION_NOT_FOUND",
        `Location ${input.id} not found`,
      );
    return location;
  });

/**
 * Explicit pick, not a spread: the roster reads ignore the date, valuation, and
 * count filters by design, and their narrowed param type makes that a compile
 * error rather than a silent drop.
 */
const rosterFilters = (filters: z.infer<typeof locationFiltersSchema>) => ({
  nameFilter: filters.nameFilter,
  itemTypeFilter: filters.itemTypeFilter,
  parentId: filters.parentId,
  parentPresenceFilter: filters.parentPresenceFilter,
  inventoryPresenceFilter: filters.inventoryPresenceFilter,
  productId: filters.productId,
  productPresenceFilter: filters.productPresenceFilter,
});

// Both roster reads take `list`'s filters/pagination shape but skip the
// inventory-entry / product / valuation relation load AND the batched
// product-pricing pass that `list` pays for — none of which a dropdown row
// renders. Both default to name order, not `list`'s `createdAt`, because a
// roster in creation order is unscannable.

/** Breadcrumb-only picklist: a name and its ancestry, no thumbnail, no cover load. */
const { list: options } = createEntityListProcedure({
  schemas: {
    output: locationOptionItemOut,
    filters: locationFiltersSchema,
    sort: {
      sortableFields: locationPickerSortableFields,
      defaultSort: "name",
    },
  },
  repository: {
    list: async (services, filters, sort, pagination) =>
      await locationOptions(
        services.db,
        rosterFilters(filters),
        sort,
        pagination,
      ),
  },
  entityName: "location",
});

/** Picker typeahead: the same roster plus each row's cover photo. */
const { list: search } = createEntityListProcedure({
  schemas: {
    output: locationPickerItemOut,
    filters: locationFiltersSchema,
    sort: {
      sortableFields: locationPickerSortableFields,
      defaultSort: "name",
    },
  },
  repository: {
    list: async (services, filters, sort, pagination) =>
      await locationSearch(
        services.db,
        rosterFilters(filters),
        sort,
        pagination,
      ),
  },
  entityName: "location",
});

const makeTree = protectedProcedure
  .output(strictOutput(infLocationListOut))
  .query(async ({ ctx }) => await buildLocationTree(ctx.db));

const valuationSummary = protectedProcedure
  .output(strictOutput(locationValuationSummaryOut))
  .query(({ ctx }) => getLocationValuationSummary(ctx.db));

/**
 * The descendant forest under one location — every level, in one query. Powers
 * the location detail page's Contents tree table, where the detail read's
 * single level of children stops one twirl short.
 */
const subtree = protectedProcedure
  .input(z.object({ shortcode: locationShortcode }))
  .output(strictOutput(infLocationListOut))
  .query(
    async ({ ctx, input }) =>
      await buildLocationTree(
        ctx.db,
        await locationShortcodes.one(ctx.db, input.shortcode),
      ),
  );

/** Count-only, root-included hierarchy for the location drill-down chart. */
const inventoryBreakdown = protectedProcedure
  .input(z.object({ shortcode: locationShortcode }))
  .output(strictOutput(locationInventoryBreakdownOut.nullable()))
  .query(async ({ ctx, input }) =>
    getLocationInventoryBreakdown(
      ctx.db,
      await locationShortcodes.one(ctx.db, input.shortcode),
    ),
  );

/**
 * Lightweight `{id, name}` options for the location filter's parent picklist
 * (see `useLocationParentOptions`) — only locations with at least one live
 * child, not the full location roster (see repo/location/lookup.ts's
 * `locationParentOptions`). Mirrors `project.options`' role/shape.
 */
const parentOptions = protectedProcedure
  .output(strictOutput(z.array(locationParentOptionsOut)))
  .query(({ ctx }) => locationParentOptions(ctx.db));

const ensureGlobalUnknown = protectedProcedure
  .output(strictOutput(infLocation))
  .mutation(async ({ ctx }) => {
    const location = await ensureGlobalUnknownLocation(
      ctx.db,
      ctx.actorContext,
    );
    const entityId = await locationShortcodes.one(ctx.db, location.id);
    await runMutationSideEffects(ctx.db, {
      action: "updated",
      entity: { entityType: "location", entityId },
      source: "location.ensureGlobalUnknown",
    });
    return location;
  });

const bulkUpdateParent = protectedProcedure
  .input(locationBulkUpdateParentInput)
  .output(strictOutput(locationBulkUpdateParentOut))
  .mutation(async ({ ctx, input }) => {
    if (input.parentId && input.ids.includes(input.parentId)) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Cannot move a location under itself.",
      );
    }

    const ids = uniq(await locationShortcodes.all(ctx.db, input.ids));
    const parentId = input.parentId
      ? await locationShortcodes.one(ctx.db, input.parentId)
      : null;

    await bulkReparentLocations(ctx.db, ids, parentId, ctx.actorContext);

    await runMutationSideEffectsForEntities(
      ctx.db,
      ids.map((id) => ({
        action: "updated" as const,
        entity: { entityType: "location" as const, entityId: id },
        source: "location.bulkUpdateParent",
      })),
    );
    return { updated: ids.length };
  });

// Batch lookup: multiple locations by shortcode (e.g. for label printing)
const getByShortcodes = protectedProcedure
  .input(locationShortcodesInput)
  .output(strictOutput(locationsWithParentNameOut))
  .query(async ({ ctx, input }) => {
    return await getLocationsByShortcodes(ctx.db, input.shortcodes);
  });

// Manual whole-tree recompute of persisted location valuations. Used to populate
// after the column is first added, and as a safety net for writes that bypass the
// router (raw SQL / postgres MCP). Idempotent — same inventory → same numbers.
const recomputeValuations = protectedProcedure
  .output(strictOutput(recomputeLocationValuationsOut))
  .mutation(async ({ ctx }) => {
    const updated = await ctx.services.locationValuation.recompute();
    return { updated };
  });

export const locationRouter = createTRPCRouter({
  list,
  search,
  options,
  getByID,
  getByShortcodes,
  makeTree,
  valuationSummary,
  subtree,
  inventoryBreakdown,
  parentOptions,
  ensureGlobalUnknown,
  create,
  update,
  recomputeValuations,
  delete: deleteItem,
  bulkUpdateParent,
});
