import { locationContract } from "~/contracts/location.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const location = defineOperationDomain(locationContract, {
  makeTree: { tags: [["location", "makeTree"]], cache: "browse" },
  valuationSummary: { tags: [["location", "valuationSummary"]] },
  ensureGlobalUnknown: { invalidates: ripple.location },
  bulkUpdateParent: { invalidates: ripple.locationReparent },
  getByShortcodes: { tags: [["location", "getByShortcodes"]] },
  search: { tags: [["location", "search"]] },
  subtree: { tags: [["location", "subtree"]] },
  inventoryBreakdown: {
    tags: [["location", "inventoryBreakdown"], ["inventory"]],
  },
});
