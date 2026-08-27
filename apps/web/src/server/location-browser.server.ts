import { z } from "zod";
import { location } from "~/app/locations/location.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  bulkUpdateParentWorkflow,
  ensureGlobalUnknownWorkflow,
  getByShortcodesWorkflow,
  inventoryBreakdownWorkflow,
  locationPickerItemOut,
  locationSearchWorkflow,
  makeTreeWorkflow,
  parentOptionsWorkflow,
  recomputeValuationsWorkflow,
  subtreeWorkflow,
  valuationSummaryWorkflow,
} from "~/server/workflows/location.server";

export const locationHandlers = implementOperationDomain(location, {
  makeTree: makeTreeWorkflow,
  valuationSummary: valuationSummaryWorkflow,
  subtree: subtreeWorkflow,
  inventoryBreakdown: inventoryBreakdownWorkflow,
  parentOptions: parentOptionsWorkflow,
  ensureGlobalUnknown: ensureGlobalUnknownWorkflow,
  bulkUpdateParent: bulkUpdateParentWorkflow,
  getByShortcodes: getByShortcodesWorkflow,
  recomputeValuations: recomputeValuationsWorkflow,
  search: {
    run: locationSearchWorkflow,
    /**
     * The client declaration transforms the payload (adding an `items`
     * alias) for its own consumers; the wire format stays the raw
     * `{ data, count }` the workflow produces.
     */
    output: z.object({
      data: z.array(locationPickerItemOut),
      count: z.number(),
    }),
  },
});
