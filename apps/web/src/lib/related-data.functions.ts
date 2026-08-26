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
import {
  defineOperationDomain,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const relatedData = defineOperationDomain("relatedData", {
  previews: query({
    input: relatedPreviewInput,
    output: relatedPreviewOutput,
    tags: [["relatedData"], ["relatedData", "previews"]],
  }),
  branch: query({
    input: relatedBranchInput,
    output: relatedBranchOutput,
    tags: [["relatedData"], ["relatedData", "branch"]],
  }),
  options: query({
    input: relatedOptionsInput,
    output: relatedOptionsOutput,
    tags: [["relatedData"], ["relatedData", "options"]],
  }),
  summary: query({
    input: relatedSummaryInput,
    output: relatedSummaryOutput,
    tags: [["relatedData"], ["relatedData", "summary"]],
  }),
});
