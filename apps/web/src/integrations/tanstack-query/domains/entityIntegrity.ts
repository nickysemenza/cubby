import { entityIntegrityContract } from "~/contracts/entity-integrity.contract";

import { defineOperationDomain } from "../operation-catalog";

export const entityIntegrity = /* @__PURE__ */ defineOperationDomain(
  entityIntegrityContract,
);
