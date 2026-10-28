import { relatedDataContract } from "~/contracts/related-data.contract";

import { defineOperationDomain } from "../operation-catalog";

export const relatedData =
  /* @__PURE__ */ defineOperationDomain(relatedDataContract);
