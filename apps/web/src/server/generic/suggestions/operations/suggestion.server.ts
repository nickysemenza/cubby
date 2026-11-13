import { suggestionContract } from "~/contracts/suggestion.contract";
import { applyFieldAuthorityAction } from "~/server/ai/fields/repo/field-actions";
import { readFieldGuess } from "~/server/ai/fields/repo/field-origin";
import { withAfterCommitScope } from "~/server/db/helpers/core";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  reviewSuggestion,
  reviewSuggestionBatch,
} from "~/server/generic/suggestions/repo/review";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const suggestionHandlers = implementOperationDomain(suggestionContract, {
  review: (context, input) => reviewSuggestion(context.db, context, input),
  fieldGuess: async (context, input) => ({
    guess: await readFieldGuess(
      context.db,
      input.entity,
      await resolveOrThrow(context.db, input.entity, input.id),
      input.field,
    ),
  }),
  fieldAuthority: (context, input) =>
    applyFieldAuthorityAction(context.db, context.actorContext, input),
  reviewBatch: (context, input) =>
    withAfterCommitScope(() =>
      reviewSuggestionBatch(context.db, context, input),
    ),
});
