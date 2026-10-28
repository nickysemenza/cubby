import { connectionContract } from "~/contracts/entity-graph.contract";

import { defineOperationDomain } from "../operation-catalog";

export const connection =
  /* @__PURE__ */ defineOperationDomain(connectionContract);
