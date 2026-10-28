import { runContract } from "~/contracts/run.contract";

import { defineOperationDomain } from "../operation-catalog";

export const run = /* @__PURE__ */ defineOperationDomain(runContract);
