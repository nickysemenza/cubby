import { vendorContract } from "~/contracts/vendor.contract";

import { defineOperationDomain } from "../operation-catalog";

export const vendor = /* @__PURE__ */ defineOperationDomain(vendorContract);
