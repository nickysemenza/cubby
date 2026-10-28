import { locationContract } from "~/contracts/location.contract";

import { defineOperationDomain } from "../operation-catalog";

export const location = /* @__PURE__ */ defineOperationDomain(locationContract);
