import {
  fieldExplanationInput,
  fieldExplanationOutput,
} from "@cubby/schemas/field-explanation";

import { ENTITY_ROOT_TAGS } from "~/contracts/cache-policy";
import { defineContract, query } from "~/contracts/define";

export const fieldExplanationContract = defineContract(
  "fieldExplanation",
  {
    explain: query({
      description:
        "Explain a named field from its schema and supplied record context. This may use the decision model; review the explanation as guidance, not a write authorization.",
      modelBacked: true,
      input: fieldExplanationInput,
      output: fieldExplanationOutput,
      cache: { tags: ENTITY_ROOT_TAGS, profile: "live-status" },
    }),
  },
  { exposure: "capability" },
);
