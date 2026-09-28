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
  locationSearch,
  reparentLocationsInBulk,
} from "~/server/repo/location";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import {
  bindWorkflow,
  defineWorkflowOperation,
  workflow,
} from "~/server/workflow-runtime";

export type LocationWorkflowContext = {
  db: Database;
  actorContext: ActorContext;
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

export const locationSearchWorkflow = defineWorkflowOperation(
  "location.search",
  async (
    ctx: LocationWorkflowContext,
    input: {
      filters: z.input<typeof locationFiltersSchema>;
      sort: { orderBy: string; direction: "asc" | "desc" };
      pagination: { pageIndex: number; pageSize: number };
    },
  ) =>
    locationSearch(
      ctx.db,
      rosterFilters(locationFiltersSchema.parse(input.filters)),
      [input.sort],
      input.pagination,
    ),
);

export const makeTreeWorkflow = defineWorkflowOperation(
  "location.makeTree",
  async (ctx: LocationWorkflowContext) => buildLocationTree(ctx.db),
);
export const valuationSummaryWorkflow = defineWorkflowOperation(
  "location.valuationSummary",
  async (ctx: LocationWorkflowContext) => getLocationValuationSummary(ctx.db),
);
export const subtreeWorkflow = bindWorkflow(
  workflow<LocationWorkflowContext, { shortcode: string }>("location.subtree")
    .call("resolve", async ({ context }, { input }) =>
      shortcodes.one(context.db, input.shortcode),
    )
    .call("read", async ({ context }, { resolve }) =>
      buildLocationTree(context.db, resolve),
    )
    .output(({ read }) => read),
);
export const inventoryBreakdownWorkflow = bindWorkflow(
  workflow<LocationWorkflowContext, { shortcode: string }>(
    "location.inventoryBreakdown",
  )
    .call("resolve", async ({ context }, { input }) =>
      shortcodes.one(context.db, input.shortcode),
    )
    .call("read", async ({ context }, { resolve }) =>
      getLocationInventoryBreakdown(context.db, resolve),
    )
    .output(({ read }) => read),
);
export const ensureGlobalUnknownWorkflow = bindWorkflow(
  workflow<LocationWorkflowContext, undefined>("location.ensureGlobalUnknown")
    .commit("location", async ({ context }) =>
      ensureGlobalUnknownLocation(context.db, context.actorContext),
    )
    .effect("entityId", async ({ context }, { location }) =>
      shortcodes.one(context.db, location.id),
    )
    .effect("effects", async ({ context }, { entityId }) =>
      runMutationSideEffects(context.db, {
        action: "updated",
        entity: { entity: "location", id: entityId },
        source: "location.ensureGlobalUnknown",
      }),
    )
    .output(({ location }) => location),
  (context: LocationWorkflowContext) => ({ context, input: undefined }),
);

/**
 * Kept alongside the kernel's `location.bulkUpdate`: the arrange surface, the
 * location sweep and the reparent dialog all drive this operation, and all
 * three share {@link reparentLocationsInBulk} with the kernel path. Its `ids`
 * bound is 3000, where the kernel's shared id schema caps at 500.
 */
export const bulkUpdateParentWorkflow = bindWorkflow(
  workflow<
    LocationWorkflowContext,
    z.input<typeof locationBulkUpdateParentInput>
  >("location.bulkUpdateParent")
    .call("values", async (_, { input }) =>
      locationBulkUpdateParentInput.parse(input),
    )
    .commit("reparent", async ({ context }, { values }) =>
      reparentLocationsInBulk(
        context.db,
        context.actorContext,
        values.ids,
        values.parentId ?? null,
      ),
    )
    .output(({ reparent }) => ({ updated: reparent.updated })),
  (
    context: LocationWorkflowContext,
    input: z.input<typeof locationBulkUpdateParentInput>,
  ) => ({ context, input }),
);

export const getByShortcodesWorkflow = defineWorkflowOperation(
  "location.getByShortcodes",
  async (
    ctx: LocationWorkflowContext,
    input: z.input<typeof locationShortcodesInput>,
  ) =>
    getLocationsByShortcodes(
      ctx.db,
      locationShortcodesInput.parse(input).shortcodes,
    ),
);
export {
  locationBulkUpdateParentInput,
  locationFiltersSchema,
  locationShortcodesInput,
};
