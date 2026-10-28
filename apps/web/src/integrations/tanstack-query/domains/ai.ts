import { aiContract } from "~/contracts/ai.contract";

import { defineOperationDomain } from "../operation-catalog";

export const ai = /* @__PURE__ */ defineOperationDomain(aiContract);
