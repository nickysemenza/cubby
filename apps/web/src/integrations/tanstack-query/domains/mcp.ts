import { mcpContract } from "~/contracts/mcp.contract";

import { defineOperationDomain } from "../operation-catalog";

export const mcp = /* @__PURE__ */ defineOperationDomain(mcpContract);
