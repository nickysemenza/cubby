import { taskContract } from "~/contracts/task.contract";

import { defineOperationDomain } from "../operation-catalog";

export const task = /* @__PURE__ */ defineOperationDomain(taskContract);
