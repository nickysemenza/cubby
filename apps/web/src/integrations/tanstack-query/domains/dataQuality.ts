import { dataQualityContract } from "~/contracts/data-quality.contract";

import { defineOperationDomain } from "../operation-catalog";

export const dataQuality =
  /* @__PURE__ */ defineOperationDomain(dataQualityContract);
