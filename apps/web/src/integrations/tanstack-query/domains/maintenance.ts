import { maintenanceContract } from "~/contracts/maintenance.contract";

import { defineOperationDomain } from "../operation-catalog";

export const maintenance =
  /* @__PURE__ */ defineOperationDomain(maintenanceContract);
