import {
  infLocation,
  infLocationListOut,
  locationFiltersSchema,
  locationInventoryBreakdownOut,
  locationPickerItemOut,
  locationShortcodesInput,
  locationsWithParentNameOut,
  locationValuationSummaryOut,
} from "@cubby/schemas/location";
import { sortDirection } from "@cubby/schemas/pagination";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

const rosterInput = z.object({
  filters: locationFiltersSchema,
  sort: z.object({ orderBy: z.string(), direction: sortDirection }),
  pagination: z.object({ pageIndex: z.number(), pageSize: z.number() }),
});
const searchOutput = z.object({
  data: z.array(locationPickerItemOut),
  count: z.number(),
});
const shortcodeInput = z.object({ shortcode: z.string() });

export const locationContract = defineContract(
  "location",
  {
    makeTree: query({
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
      note: "The audit's relocate target",
      input: z.undefined(),
      output: infLocation,
      invalidates: ["location"],
    }),
    getByShortcodes: query({
      note: "entity_read.get per id, or entity_read.list with an ids filter on locations",
      input: locationShortcodesInput,
      output: locationsWithParentNameOut,
    }),
    search: query({
      note: "entity_read.search on locations",
      input: rosterInput,
      output: searchOutput,
    }),
    subtree: query({
      note: "entity_read.list on locations filtered by parent",
      input: shortcodeInput,
      output: infLocationListOut,
    }),
    inventoryBreakdown: query({
      input: shortcodeInput,
      output: locationInventoryBreakdownOut.nullable(),
      cache: { tags: [["location", "inventoryBreakdown"], ["inventory"]] },
    }),
  },
  { exposure: "view" },
);
