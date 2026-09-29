import { relatedDataContract } from "~/contracts/related-data.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  loadRelatedBranch,
  loadRelatedOptions,
  loadRelatedPreviews,
  loadRelatedSummary,
} from "~/server/repo/related-view";

export const relatedDataHandlers = implementOperationDomain(
  relatedDataContract,
  {
    previews: (context, input) => loadRelatedPreviews(context.db, input),
    branch: (context, input) => loadRelatedBranch(context.db, input),
    options: (context, input) => loadRelatedOptions(context.db, input),
    summary: (context, input) => loadRelatedSummary(context.db, input),
  },
);
