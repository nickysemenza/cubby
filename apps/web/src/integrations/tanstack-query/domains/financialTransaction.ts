import { financialTransactionContract } from "~/contracts/finance.contract";

import { defineOperationDomain } from "../operation-catalog";

export const financialTransaction = /* @__PURE__ */ defineOperationDomain(
  financialTransactionContract,
);
