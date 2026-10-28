import { dashboardContract } from "~/contracts/dashboard.contract";

import { defineOperationDomain } from "../operation-catalog";

export const dashboard =
  /* @__PURE__ */ defineOperationDomain(dashboardContract);
