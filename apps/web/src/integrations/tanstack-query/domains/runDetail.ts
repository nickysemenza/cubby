import { runDetailContract } from "~/contracts/run-detail.contract";

import { defineOperationDomain } from "../operation-catalog";

export const runDetail =
  /* @__PURE__ */ defineOperationDomain(runDetailContract);
