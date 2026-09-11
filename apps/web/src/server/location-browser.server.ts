import { locationContract } from "~/contracts/location.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  bulkUpdateParentWorkflow,
  ensureGlobalUnknownWorkflow,
  getByShortcodesWorkflow,
  inventoryBreakdownWorkflow,
  locationSearchWorkflow,
  makeTreeWorkflow,
  parentOptionsWorkflow,
  recomputeValuationsWorkflow,
  subtreeWorkflow,
  valuationSummaryWorkflow,
} from "~/server/workflows/location.server";

export const locationHandlers = implementOperationDomain(locationContract, {
  makeTree: makeTreeWorkflow,
  valuationSummary: valuationSummaryWorkflow,
  subtree: subtreeWorkflow,
  inventoryBreakdown: inventoryBreakdownWorkflow,
  parentOptions: parentOptionsWorkflow,
  ensureGlobalUnknown: ensureGlobalUnknownWorkflow,
  bulkUpdateParent: bulkUpdateParentWorkflow,
  getByShortcodes: getByShortcodesWorkflow,
  recomputeValuations: recomputeValuationsWorkflow,
  search: locationSearchWorkflow,
});
