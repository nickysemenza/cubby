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
    mcp: { omit: "client_view" },
    input: relatedPreviewInput,
    output: relatedPreviewOutput,
  }),
  branch: query({
    mcp: { omit: "client_view" },
    input: relatedBranchInput,
    output: relatedBranchOutput,
  }),
  options: query({
    mcp: { omit: "client_view" },
    input: relatedOptionsInput,
    output: relatedOptionsOutput,
  }),
  summary: query({
    mcp: { omit: "client_view" },
    input: relatedSummaryInput,
    output: relatedSummaryOutput,
  }),
});
