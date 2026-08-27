import {
  infLocation,
  infLocationListOut,
  locationBulkUpdateParentInput,
  locationBulkUpdateParentOut,
  locationFiltersSchema,
  locationInventoryBreakdownOut,
  locationParentOptionsOut,
  locationPickerItemOut,
  locationShortcodesInput,
  locationsWithParentNameOut,
  locationValuationSummaryOut,
} from "@cubby/schemas/location";
import { z } from "zod";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

const rosterInput = z.object({
  filters: locationFiltersSchema,
  sort: z.object({ orderBy: z.string(), direction: z.enum(["asc", "desc"]) }),
  pagination: z.object({ pageIndex: z.number(), pageSize: z.number() }),
});
const searchOutput = z.object({
  data: z.array(locationPickerItemOut),
  count: z.number(),
});
const shortcodeInput = z.object({ shortcode: z.string() });

export const location = defineOperationDomain("location", {
  makeTree: query({
    input: z.undefined(),
    output: infLocationListOut,
    tags: [["location", "makeTree"]],
    freshness: {
      staleTime: 2 * 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  }),
  valuationSummary: query({
    input: z.undefined(),
    output: locationValuationSummaryOut,
    tags: [["location", "valuationSummary"]],
  }),
  ensureGlobalUnknown: mutation({
    input: z.undefined(),
    output: infLocation,
    invalidates: ripple.location,
  }),
  bulkUpdateParent: mutation({
    input: locationBulkUpdateParentInput,
    output: locationBulkUpdateParentOut,
    invalidates: ripple.locationReparent,
  }),
  getByShortcodes: query({
    input: locationShortcodesInput,
    output: locationsWithParentNameOut,
    tags: [["location", "getByShortcodes"]],
  }),
  recomputeValuations: mutation({
    input: z.undefined(),
    output: z.object({ updated: z.number() }),
    invalidates: ripple.locationValuation,
  }),
  search: query({
    input: rosterInput,
    output: searchOutput,
    tags: [["location", "search"]],
  }),
  subtree: query({
    input: shortcodeInput,
    output: infLocationListOut,
    tags: [["location", "subtree"]],
  }),
  inventoryBreakdown: query({
    input: shortcodeInput,
    output: locationInventoryBreakdownOut.nullable(),
    tags: [["location", "inventoryBreakdown"], ["inventory"]],
  }),
  parentOptions: query({
    input: z.undefined(),
    output: z.array(locationParentOptionsOut),
    tags: [["location", "parentOptions"]],
  }),
});
