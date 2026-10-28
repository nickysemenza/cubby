import { inventoryContract } from "~/contracts/inventory.contract";

import { defineOperationDomain } from "../operation-catalog";

export const inventory =
  /* @__PURE__ */ defineOperationDomain(inventoryContract);
