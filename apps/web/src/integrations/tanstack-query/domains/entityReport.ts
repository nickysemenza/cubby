import { entityReportContract } from "~/contracts/entity-report.contract";

import { defineOperationDomain } from "../operation-catalog";

export const entityReport =
  /* @__PURE__ */ defineOperationDomain(entityReportContract);
