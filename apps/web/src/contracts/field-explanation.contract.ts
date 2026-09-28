import {
  fieldExplanationInput,
  fieldExplanationOutput,
} from "@cubby/schemas/field-explanation";

import { ENTITY_ROOT_TAGS } from "~/contracts/cache-policy";
import { defineContract, query } from "~/contracts/define";

export const fieldExplanationContract = defineContract("fieldExplanation", {
  explain: query({
    native: "Explain a derived field",
    input: fieldExplanationInput,
    output: fieldExplanationOutput,
    cache: { tags: ENTITY_ROOT_TAGS, profile: "live-status" },
  }),
});
