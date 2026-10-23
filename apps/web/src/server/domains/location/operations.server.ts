import type { ActorContext } from "@cubby/schemas/context";
import type { locationFiltersSchema } from "@cubby/schemas/location";
import type { z } from "zod";

import { locationContract } from "~/contracts/location.contract";
import type { Database } from "~/server/db";
import { withTransactionDatabase } from "~/server/db/helpers";
import {
  ensureGlobalUnknownLocation,
  locationSearch,
} from "~/server/domains/location/repo/crud";
import { getLocationsByShortcodes } from "~/server/domains/location/repo/lookup";
import {
  buildLocationTree,
  getLocationInventoryBreakdown,
} from "~/server/domains/location/repo/tree";
import { getLocationValuationSummary } from "~/server/domains/location/repo/valuation";
import { recordChange } from "~/server/generic/changes/repo/change";
import { bindShortcodeResolver } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
import { bindWorkflow, workflow } from "~/server/workflows/runtime";

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
  includeSubLocations: filters.includeSubLocations,
  inventoryPresenceFilter: filters.inventoryPresenceFilter,
  productId: filters.productId,
  productPresenceFilter: filters.productPresenceFilter,
});

/** The upsert and source intent share one commit. */
const ensureGlobalUnknownWorkflow = bindWorkflow(
  workflow<LocationWorkflowContext, undefined>("location.ensureGlobalUnknown")
    .commit("location", async ({ context }) =>
      withTransactionDatabase(context.db, async (db) => {
        const location = await ensureGlobalUnknownLocation(
          db,
          context.actorContext,
        );
        await recordChange(db, { kind: "source", categories: ["location"] });
        return location;
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
