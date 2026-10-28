import { entityGraphContract } from "~/contracts/entity-graph.contract";

import { defineOperationDomain } from "../operation-catalog";

export const entityGraph =
  /* @__PURE__ */ defineOperationDomain(entityGraphContract);
