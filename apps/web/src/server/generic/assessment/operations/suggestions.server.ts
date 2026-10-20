import { suggestionsContract } from "~/contracts/suggestions.contract";
import {
  listAutomaticRules,
  setAutomaticRule,
} from "~/server/generic/assessment/repo/automatic-rule-runtime";
import {
  acceptCleanSuggestions,
  listSuggestionPage,
  suggestionCountsByFamily,
  suggestionRecordCounts,
} from "~/server/generic/assessment/repo/suggestion-list";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

import { listAutomaticDecisions } from "../repo/automatic-decisions";

export const suggestionsHandlers = implementOperationDomain(
  suggestionsContract,
  {
    automaticDecisions: (context, input) =>
      listAutomaticDecisions(context.db, input),
    recordCounts: (context, input) => suggestionRecordCounts(context.db, input),
    list: (context, input) => listSuggestionPage(context.db, input),
    counts: (context, input) => suggestionCountsByFamily(context.db, input),
    acceptClean: (context, input) =>
      acceptCleanSuggestions(context.db, context, input),
    rules: (context) => listAutomaticRules(context.db),
    setRule: (context, input) =>
      setAutomaticRule(context.db, context.actorContext, input),
  },
);
