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

import { defineContract, mutation, query } from "~/contracts/define";

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

export const locationContract = defineContract("location", {
  makeTree: query({
    input: z.undefined(),
    output: infLocationListOut,
  }),
  valuationSummary: query({
    input: z.undefined(),
    output: locationValuationSummaryOut,
  }),
  ensureGlobalUnknown: mutation({
    input: z.undefined(),
    output: infLocation,
  }),
  bulkUpdateParent: mutation({
    input: locationBulkUpdateParentInput,
    output: locationBulkUpdateParentOut,
  }),
  getByShortcodes: query({
    input: locationShortcodesInput,
    output: locationsWithParentNameOut,
  }),
  search: query({
    input: rosterInput,
    output: searchOutput,
  }),
  subtree: query({
    input: shortcodeInput,
    output: infLocationListOut,
  }),
  inventoryBreakdown: query({
    input: shortcodeInput,
    output: locationInventoryBreakdownOut.nullable(),
  }),
  parentOptions: query({
    input: z.undefined(),
    output: z.array(locationParentOptionsOut),
  }),
});
