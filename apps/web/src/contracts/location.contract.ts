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
    mcp: { omit: "client_view" },
    native: "Audit scope picker",
    input: z.undefined(),
    output: infLocationListOut,
    cache: { profile: "browse" },
  }),
  // Bounded Home summary; see expense.monthlySummary.
  valuationSummary: query({
    mcp: { omit: "client_view" },
    readPolicy: "strong",
    input: z.undefined(),
    output: locationValuationSummaryOut,
  }),
  ensureGlobalUnknown: mutation({
    mcp: { omit: "client_view", note: "The audit's relocate target" },
    native: "Audit relocate target",
    input: z.undefined(),
    output: infLocation,
    invalidates: ["location"],
  }),
  bulkUpdateParent: mutation({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["bulkUpdate"],
      note: "entity.bulkUpdate on location parent",
    },
    native: "Audit adopt",
    input: locationBulkUpdateParentInput,
    output: locationBulkUpdateParentOut,
    invalidates: ["locationReparent"],
  }),
  getByShortcodes: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["get", "list"],
      note: "entity_read.get per id, or entity_read.list with an ids filter on locations",
    },
    input: locationShortcodesInput,
    output: locationsWithParentNameOut,
  }),
  search: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["search"],
      note: "entity_read.search on locations",
    },
    input: rosterInput,
    output: searchOutput,
  }),
  subtree: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["list"],
      note: "entity_read.list on locations filtered by parent",
    },
    input: shortcodeInput,
    output: infLocationListOut,
  }),
  inventoryBreakdown: query({
    mcp: { omit: "client_view" },
    input: shortcodeInput,
    output: locationInventoryBreakdownOut.nullable(),
    cache: { tags: [["location", "inventoryBreakdown"], ["inventory"]] },
  }),
});
