import { entityMutationContract } from "~/contracts/entity-mutation.contract";

import { defineOperationDomain } from "../operation-catalog";
import { entityMutationOverrides } from "../operation-overrides/entityMutation";

export const entityMutation = /* @__PURE__ */ defineOperationDomain(
  entityMutationContract,
  entityMutationOverrides,
);
