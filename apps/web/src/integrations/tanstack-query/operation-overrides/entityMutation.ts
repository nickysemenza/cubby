import type { entityMutationContract } from "~/contracts/entity-mutation.contract";

import { entityMutationRipple } from "../cache-tags";
import type { OperationPolicies } from "../operation-catalog";

export const entityMutationOverrides = {
  mutate: {
    invalidates: entityMutationRipple,
  },
} satisfies OperationPolicies<(typeof entityMutationContract)["ops"]>;
