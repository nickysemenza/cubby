import type { ActorContext } from "@cubby/schemas/context";
import type { locationFiltersSchema } from "@cubby/schemas/location";
import type { z } from "zod";

import { locationContract } from "~/contracts/location.contract";
import type { Database } from "~/server/db";
import { implementOperationDomain } from "~/server/operation-domain.server";
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
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

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

/** The upsert commits first; resolving its shortcode and the side effects then
 * run as post-commit effects that a cancelled request cannot skip. */
const ensureGlobalUnknownWorkflow = bindWorkflow(
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
);

export const locationHandlers = implementOperationDomain(locationContract, {
  makeTree: (context) => buildLocationTree(context.db),
  valuationSummary: (context) => getLocationValuationSummary(context.db),
  subtree: async (context, input) =>
    buildLocationTree(
      context.db,
      await shortcodes.one(context.db, input.shortcode),
    ),
  inventoryBreakdown: async (context, input) =>
    getLocationInventoryBreakdown(
      context.db,
      await shortcodes.one(context.db, input.shortcode),
    ),
  ensureGlobalUnknown: (context) =>
    ensureGlobalUnknownWorkflow(context, undefined),
  // Kept alongside the kernel's `location.bulkUpdate`: the arrange surface, the
  // location sweep and the reparent dialog all drive this operation, and all
  // three share `reparentLocationsInBulk` with the kernel path. Its `ids`
  // bound is 3000, where the kernel's shared id schema caps at 500.
  bulkUpdateParent: async (context, input) => {
    const { updated } = await reparentLocationsInBulk(
      context.db,
      context.actorContext,
      input.ids,
      input.parentId ?? null,
    );
    return { updated };
  },
  getByShortcodes: (context, input) =>
    getLocationsByShortcodes(context.db, input.shortcodes),
  search: (context, input) =>
    locationSearch(
      context.db,
      rosterFilters(input.filters),
      [input.sort],
      input.pagination,
    ),
});
