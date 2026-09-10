import {
  loadRelatedBranch,
  loadRelatedOptions,
  loadRelatedPreviews,
  loadRelatedSummary,
} from "~/server/repo/related-view";
import { defineWorkflowOperation } from "~/server/workflow-runtime";

export const loadRelatedPreviewsWorkflow = defineWorkflowOperation(
  "relatedData.previews",
  loadRelatedPreviews,
);
export const loadRelatedBranchWorkflow = defineWorkflowOperation(
  "relatedData.branch",
  loadRelatedBranch,
);
export const loadRelatedOptionsWorkflow = defineWorkflowOperation(
  "relatedData.options",
  loadRelatedOptions,
);
export const loadRelatedSummaryWorkflow = defineWorkflowOperation(
  "relatedData.summary",
  loadRelatedSummary,
);
