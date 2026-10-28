import { jobContract } from "~/contracts/job.contract";

import { defineOperationDomain } from "../operation-catalog";

export const job = /* @__PURE__ */ defineOperationDomain(jobContract);
