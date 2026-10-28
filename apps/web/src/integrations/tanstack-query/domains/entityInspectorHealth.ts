import { entityInspectorHealthContract } from "~/contracts/entity-inspector-health.contract";

import { defineOperationDomain } from "../operation-catalog";

export const entityInspectorHealth = /* @__PURE__ */ defineOperationDomain(
  entityInspectorHealthContract,
);
