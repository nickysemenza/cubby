import { entityListContract } from "~/contracts/entity-list.contract";

import { defineOperationDomain } from "../operation-catalog";
import { entityListOverrides } from "../operation-overrides/entityList";

export const entityList = /* @__PURE__ */ defineOperationDomain(
  entityListContract,
  entityListOverrides,
);
