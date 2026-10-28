import { upcContract } from "~/contracts/upc.contract";

import { defineOperationDomain } from "../operation-catalog";

export const upc = /* @__PURE__ */ defineOperationDomain(upcContract);
