import { allEntities } from "@cubby/schemas/entity-manifest";

import { fieldExplanationContract } from "~/contracts/field-explanation.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const fieldExplanation = defineOperationDomain(
  fieldExplanationContract,
  {
    explain: {
      cache: "live-status",
      tags: allEntities.map((entity) => [entity] as const),
    },
  },
);
