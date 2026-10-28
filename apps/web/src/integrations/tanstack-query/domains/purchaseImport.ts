import { purchaseImportContract } from "~/contracts/purchase-import.contract";

import { defineOperationDomain } from "../operation-catalog";

export const purchaseImport = /* @__PURE__ */ defineOperationDomain(
  purchaseImportContract,
);
