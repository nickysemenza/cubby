import { cashFlowContract } from "~/contracts/finance.contract";

import { defineOperationDomain } from "../operation-catalog";

export const cashFlow = /* @__PURE__ */ defineOperationDomain(cashFlowContract);
