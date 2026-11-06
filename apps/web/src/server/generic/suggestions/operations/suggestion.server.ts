import { suggestionContract } from "~/contracts/suggestion.contract";
import {
  reviewSuggestion,
  reviewSuggestionBatch,
} from "~/server/generic/suggestions/repo/review";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const suggestionHandlers = implementOperationDomain(suggestionContract, {
  review: (context, input) => reviewSuggestion(context.db, context, input),
  reviewBatch: (context, input) =>
    reviewSuggestionBatch(context.db, context, input),
});
