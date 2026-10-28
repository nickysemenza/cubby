import { entityMediaContract } from "~/contracts/entity-media.contract";

import { defineOperationDomain } from "../operation-catalog";

export const entityMedia =
  /* @__PURE__ */ defineOperationDomain(entityMediaContract);
