import { relatedDataContract } from "~/contracts/related-data.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  loadRelatedBranchWorkflow,
  loadRelatedOptionsWorkflow,
  loadRelatedPreviewsWorkflow,
  loadRelatedSummaryWorkflow,
} from "~/server/workflows/related-data.server";

export const relatedDataHandlers = implementOperationDomain(
  relatedDataContract,
  {
    previews: (context, input) =>
      loadRelatedPreviewsWorkflow(context.readDb, input),
    branch: (context, input) =>
      loadRelatedBranchWorkflow(context.readDb, input),
    options: (context, input) =>
      loadRelatedOptionsWorkflow(context.readDb, input),
    summary: (context, input) =>
      loadRelatedSummaryWorkflow(context.readDb, input),
  },
);
