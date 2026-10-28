import { assessmentContract } from "~/contracts/assessment.contract";

import { defineOperationDomain } from "../operation-catalog";

export const assessment =
  /* @__PURE__ */ defineOperationDomain(assessmentContract);
