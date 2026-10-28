import { entityFilterOptionsContract } from "~/contracts/entity-filter-options.contract";

import { defineOperationDomain } from "../operation-catalog";

export const entityFilterOptions = /* @__PURE__ */ defineOperationDomain(
  entityFilterOptionsContract,
);
