import { problemsContract } from "~/contracts/problems.contract";

import { defineOperationDomain } from "../operation-catalog";

export const problems = /* @__PURE__ */ defineOperationDomain(problemsContract);
