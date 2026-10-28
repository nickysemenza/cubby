import { fieldExplanationContract } from "~/contracts/field-explanation.contract";

import { defineOperationDomain } from "../operation-catalog";

export const fieldExplanation = /* @__PURE__ */ defineOperationDomain(
  fieldExplanationContract,
);
