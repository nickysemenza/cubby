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
      loadRelatedPreviewsWorkflow(context.db, input),
    branch: (context, input) => loadRelatedBranchWorkflow(context.db, input),
    options: (context, input) => loadRelatedOptionsWorkflow(context.db, input),
    summary: (context, input) => loadRelatedSummaryWorkflow(context.db, input),
  },
);
