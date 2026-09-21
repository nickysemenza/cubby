import { inventoryContract } from "~/contracts/inventory.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const inventory = defineOperationDomain(inventoryContract, {
  bulkProcess: { invalidates: ripple.inventory },
  bulkAdd: { invalidates: ripple.inventory },
  // `ripple.expense`, not `ripple.inventory`: a discard mints a $0 Expense per
  // row, and that ripple already carries the stock surfaces (see `costAndStock`)
  // alongside the ledger ones the narrower inventory ripple omits. Same choice
  // as the single-row `product.discard`.
  bulkDiscard: { invalidates: ripple.expense },
  bulkMove: { invalidates: ripple.inventory },
  moveEntries: { invalidates: ripple.inventory },
  reconcileSession: { invalidates: ripple.inventory },
  scanAtLocation: { invalidates: ripple.inventory },
  resolveScanStrays: { invalidates: ripple.inventory },
  findDuplicates: { tags: [["inventory", "findDuplicates"]] },
  getByLocationIds: { tags: [["inventory", "getByLocationIds"]] },
  locationSnapshot: { tags: [["inventory", "locationSnapshot"]] },
  setOwnership: { invalidates: ripple.inventory },
  confirmOwnership: { invalidates: ripple.inventory },
});
