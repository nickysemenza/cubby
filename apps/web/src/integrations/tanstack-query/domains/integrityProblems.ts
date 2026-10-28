import { integrityProblemsContract } from "~/contracts/entity-integrity.contract";

import { defineOperationDomain } from "../operation-catalog";

export const integrityProblems = /* @__PURE__ */ defineOperationDomain(
  integrityProblemsContract,
);
