import {
  fieldExplanationInput,
  fieldExplanationOutput,
} from "@cubby/schemas/field-explanation";

import { defineContract, query } from "~/contracts/define";

export const fieldExplanationContract = defineContract("fieldExplanation", {
  explain: query({
    native: "Explain a derived field",
    input: fieldExplanationInput,
    output: fieldExplanationOutput,
  }),
});
