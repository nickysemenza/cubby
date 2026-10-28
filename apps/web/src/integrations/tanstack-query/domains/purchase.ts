import { purchaseContract } from "~/contracts/purchase.contract";

import { defineOperationDomain } from "../operation-catalog";

export const purchase = /* @__PURE__ */ defineOperationDomain(purchaseContract);
