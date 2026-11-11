import { suggestionContract } from "~/contracts/suggestion.contract";
import { withAfterCommitScope } from "~/server/db/helpers/core";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  fieldAuthority,
  readFieldGuess,
} from "~/server/generic/suggestions/repo/field-authority";
import { applyFieldAuthorityAction } from "~/server/generic/suggestions/repo/field-authority-actions";
import {
  reviewSuggestion,
  reviewSuggestionBatch,
} from "~/server/generic/suggestions/repo/review";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const suggestionHandlers = implementOperationDomain(suggestionContract, {
  review: (context, input) => reviewSuggestion(context.db, context, input),
  fieldGuess: async (context, input) => {
    const recordId = await resolveOrThrow(context.db, input.entity, input.id);
    const authority = await fieldAuthority(
      context.db,
      input.entity,
      recordId,
      input.field,
    );
    return {
      guess:
        authority.holder === "person"
          ? null
          : await readFieldGuess(
              context.db,
              input.entity,
              recordId,
              input.field,
            ),
    };
  },
  fieldAuthority: (context, input) =>
    applyFieldAuthorityAction(context.db, context, input),
  reviewBatch: (context, input) =>
    withAfterCommitScope(() =>
      reviewSuggestionBatch(context.db, context, input),
    ),
});
