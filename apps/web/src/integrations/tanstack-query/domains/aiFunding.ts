import { aiFundingContract } from "~/contracts/ai.contract";

import { defineOperationDomain } from "../operation-catalog";

export const aiFunding =
  /* @__PURE__ */ defineOperationDomain(aiFundingContract);
