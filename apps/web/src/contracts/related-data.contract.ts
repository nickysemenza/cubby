import {
  relatedBranchInput,
  relatedBranchOutput,
  relatedOptionsInput,
  relatedOptionsOutput,
  relatedPreviewInput,
  relatedPreviewOutput,
  relatedSummaryInput,
  relatedSummaryOutput,
} from "@cubby/schemas/related-view";

import { defineContract, query } from "~/contracts/define";

export const relatedDataContract = defineContract("relatedData", {
  previews: query({
    input: relatedPreviewInput,
    output: relatedPreviewOutput,
  }),
  branch: query({
    input: relatedBranchInput,
    output: relatedBranchOutput,
  }),
  options: query({
    input: relatedOptionsInput,
    output: relatedOptionsOutput,
  }),
  summary: query({
    input: relatedSummaryInput,
    output: relatedSummaryOutput,
  }),
});
