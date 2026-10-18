import { suggestionsContract } from "~/contracts/suggestions.contract";
import {
  acceptCleanSuggestions,
  listSuggestionPage,
  suggestionCountsByFamily,
} from "~/server/generic/assessment/repo/suggestion-list";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const suggestionsHandlers = implementOperationDomain(
  suggestionsContract,
  {
    list: (context, input) => listSuggestionPage(context.db, input),
    counts: (context, input) => suggestionCountsByFamily(context.db, input),
    acceptClean: (context, input) =>
      acceptCleanSuggestions(context.db, context, input),
  },
);
