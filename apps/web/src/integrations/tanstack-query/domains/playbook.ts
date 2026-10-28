import { playbookContract } from "~/contracts/mcp.contract";

import { defineOperationDomain } from "../operation-catalog";

export const playbook = /* @__PURE__ */ defineOperationDomain(playbookContract);
