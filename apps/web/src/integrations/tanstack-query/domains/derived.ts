import { derivedContract } from "~/contracts/derived.contract";

import { defineOperationDomain } from "../operation-catalog";

export const derived = /* @__PURE__ */ defineOperationDomain(derivedContract);
