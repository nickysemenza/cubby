import { workQueueContract } from "~/contracts/work-queue.contract";

import { defineOperationDomain } from "../operation-catalog";

export const workQueue =
  /* @__PURE__ */ defineOperationDomain(workQueueContract);
