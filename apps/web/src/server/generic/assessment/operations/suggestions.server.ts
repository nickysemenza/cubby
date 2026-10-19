import { suggestionsContract } from "~/contracts/suggestions.contract";
import {
  listAutomaticRules,
  setAutomaticRule,
} from "~/server/generic/assessment/repo/automatic-rule-runtime";
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
    rules: (context) => listAutomaticRules(context.db),
    setRule: (context, input) =>
      setAutomaticRule(context.db, context.actorContext, input),
  },
);
