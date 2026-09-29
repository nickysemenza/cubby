import {
  infLocation,
  infLocationListOut,
  locationBulkUpdateParentInput,
  locationBulkUpdateParentOut,
  locationFiltersSchema,
  locationInventoryBreakdownOut,
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
    native: "Audit scope picker",
    input: z.undefined(),
    output: infLocationListOut,
    cache: { profile: "browse" },
  }),
  // Bounded Home summary; see expense.monthlySummary.
  valuationSummary: query({
    readPolicy: "strong",
    input: z.undefined(),
    output: locationValuationSummaryOut,
  }),
  ensureGlobalUnknown: mutation({
    native: "Audit relocate target",
    input: z.undefined(),
    output: infLocation,
    invalidates: ["location"],
  }),
  bulkUpdateParent: mutation({
    native: "Audit adopt",
    input: locationBulkUpdateParentInput,
    output: locationBulkUpdateParentOut,
    invalidates: ["locationReparent"],
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
    cache: { tags: [["location", "inventoryBreakdown"], ["inventory"]] },
  }),
});
