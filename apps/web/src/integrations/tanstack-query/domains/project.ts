import { projectContract } from "~/contracts/project.contract";

import { defineOperationDomain } from "../operation-catalog";

export const project = /* @__PURE__ */ defineOperationDomain(projectContract);
