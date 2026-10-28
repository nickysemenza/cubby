import { searchContract } from "~/contracts/search.contract";

import { defineOperationDomain } from "../operation-catalog";

export const search = /* @__PURE__ */ defineOperationDomain(searchContract);
