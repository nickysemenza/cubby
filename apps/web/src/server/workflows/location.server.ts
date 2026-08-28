import type { ActorContext } from "@cubby/schemas/context";
import {
  locationBulkUpdateParentInput,
  locationFiltersSchema,
  locationShortcodesInput,
} from "@cubby/schemas/location";
import type { z } from "zod";

import type { Database } from "~/server/db";
import {
  buildLocationTree,
  ensureGlobalUnknownLocation,
  getLocationInventoryBreakdown,
  getLocationsByShortcodes,
  getLocationValuationSummary,
  locationParentOptions,
  locationSearch,
  reparentLocationsInBulk,
} from "~/server/repo/location";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import type { LocationValuationService } from "~/server/services/location-valuation.service";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";

export type LocationWorkflowContext = {
  db: Database;
  actorContext: ActorContext;
  services: { locationValuation: LocationValuationService };
};

const shortcodes = bindShortcodeResolver("location");
const rosterFilters = (filters: z.infer<typeof locationFiltersSchema>) => ({
  nameFilter: filters.nameFilter,
  itemTypeFilter: filters.itemTypeFilter,
  parentId: filters.parentId,
  parentPresenceFilter: filters.parentPresenceFilter,
  inventoryPresenceFilter: filters.inventoryPresenceFilter,
  productId: filters.productId,
  productPresenceFilter: filters.productPresenceFilter,
});

export const locationSearchWorkflow = async (
  ctx: LocationWorkflowContext,
  input: {
    filters: z.input<typeof locationFiltersSchema>;
    sort: { orderBy: string; direction: "asc" | "desc" };
    pagination: { pageIndex: number; pageSize: number };
  },
) =>
  await locationSearch(
    ctx.db,
    rosterFilters(locationFiltersSchema.parse(input.filters)),
    [input.sort],
    input.pagination,
  );

export const makeTreeWorkflow = async (ctx: LocationWorkflowContext) =>
  await buildLocationTree(ctx.db);
export const valuationSummaryWorkflow = async (ctx: LocationWorkflowContext) =>
  getLocationValuationSummary(ctx.db);
export const subtreeWorkflow = async (
  ctx: LocationWorkflowContext,
  input: { shortcode: string },
) =>
  await buildLocationTree(
    ctx.db,
    await shortcodes.one(ctx.db, input.shortcode),
  );
export const inventoryBreakdownWorkflow = async (
  ctx: LocationWorkflowContext,
  input: { shortcode: string },
) =>
  getLocationInventoryBreakdown(
    ctx.db,
    await shortcodes.one(ctx.db, input.shortcode),
  );
export const parentOptionsWorkflow = async (ctx: LocationWorkflowContext) =>
  locationParentOptions(ctx.db);

export const ensureGlobalUnknownWorkflow = async (
  ctx: LocationWorkflowContext,
) => {
  const location = await ensureGlobalUnknownLocation(ctx.db, ctx.actorContext);
  const entityId = await shortcodes.one(ctx.db, location.id);
  await runMutationSideEffects(ctx.db, {
    action: "updated",
    entity: { entityType: "location", entityId },
    source: "location.ensureGlobalUnknown",
  });
  return location;
};

/**
 * Kept alongside the kernel's `location.bulkUpdate`: the arrange surface, the
 * location sweep and the reparent dialog all drive this operation, and all
 * three share {@link reparentLocationsInBulk} with the kernel path. Its `ids`
 * bound is 3000, where the kernel's shared id schema caps at 500.
 */
export const bulkUpdateParentWorkflow = async (
  ctx: LocationWorkflowContext,
  input: z.input<typeof locationBulkUpdateParentInput>,
) => {
  const values = locationBulkUpdateParentInput.parse(input);
  const { updated } = await reparentLocationsInBulk(
    ctx.db,
    ctx.actorContext,
    values.ids,
    values.parentId ?? null,
  );
  return { updated };
};

export const getByShortcodesWorkflow = async (
  ctx: LocationWorkflowContext,
  input: z.input<typeof locationShortcodesInput>,
) =>
  getLocationsByShortcodes(
    ctx.db,
    locationShortcodesInput.parse(input).shortcodes,
  );
export const recomputeValuationsWorkflow = async (
  ctx: LocationWorkflowContext,
) => ({ updated: await ctx.services.locationValuation.recompute() });

export {
  locationBulkUpdateParentInput,
  locationFiltersSchema,
  locationShortcodesInput,
};
