import { spendingClassificationContract } from "~/contracts/spending-classification.contract";

import { defineOperationDomain } from "../operation-catalog";

export const spendingClassification = /* @__PURE__ */ defineOperationDomain(
  spendingClassificationContract,
);
