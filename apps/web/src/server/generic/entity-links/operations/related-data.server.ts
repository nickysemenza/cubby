import { relatedDataContract } from "~/contracts/related-data.contract";
import {
  loadRelatedBranch,
  loadRelatedOptions,
  loadRelatedPreviews,
  loadRelatedSummary,
} from "~/server/generic/entity-links/repo/related-view";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const relatedDataHandlers = implementOperationDomain(
  relatedDataContract,
  {
    previews: (context, input) => loadRelatedPreviews(context.db, input),
    branch: (context, input) => loadRelatedBranch(context.db, input),
    options: (context, input) => loadRelatedOptions(context.db, input),
    summary: (context, input) => loadRelatedSummary(context.db, input),
  },
);
