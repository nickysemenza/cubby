import { cookbookContract } from "~/contracts/cookbook.contract";

import { defineOperationDomain } from "../operation-catalog";

export const cookbook = /* @__PURE__ */ defineOperationDomain(cookbookContract);
