import { entityDetailContract } from "~/contracts/entity-detail.contract";

import { defineOperationDomain } from "../operation-catalog";
import { entityDetailOverrides } from "../operation-overrides/entityDetail";

export const entityDetail = /* @__PURE__ */ defineOperationDomain(
  entityDetailContract,
  entityDetailOverrides,
);
