import {
  dismissProductRecommendationInput,
  duplicateProductRecommendationInput,
  duplicateProductRecommendationOut,
  recommendationWorkbenchInput,
  recommendationWorkbenchOut,
} from "@cubby/schemas/recommendations";
import { createAppError } from "~/server/errors/app-error";
import { findDuplicateProductIdentities } from "~/server/repo/problems";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  dismissSuggestion,
  suggestionCandidateKey,
} from "~/server/repo/suggestion-dismissal";
import { getProductRelatedness } from "~/server/services/relatedness.service";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

export const recommendationsRouter = createTRPCRouter({
  product: protectedProcedure
    .input(recommendationWorkbenchInput)
    .output(strictOutput(recommendationWorkbenchOut))
    .query(
      async ({ ctx, input }) =>
        await getProductRelatedness(ctx.db, input.sourceId),
    ),

  duplicateProduct: protectedProcedure
    .input(duplicateProductRecommendationInput)
    .output(strictOutput(duplicateProductRecommendationOut))
    .query(async ({ ctx, input }) => {
      const candidates = await findDuplicateProductIdentities(ctx.db);
      return (
        candidates.find((candidate) =>
          candidate.products.some((product) => product.id === input.sourceId),
        ) ?? null
      );
    }),

  dismissProduct: protectedProcedure
    .input(dismissProductRecommendationInput)
    .mutation(async ({ ctx, input }) => {
      const sourceEntityId = await resolveOrThrow(
        ctx.db,
        "product",
        input.sourceId,
      );
      const current = await getProductRelatedness(ctx.db, input.sourceId);
      const stillCurrent = [
        ...current.items,
        ...current.groups.flatMap((group) => group.items),
      ].some((item) => item.shortcode === input.targetId);
      if (!stillCurrent) {
        throw createAppError(
          "PRODUCT_NOT_FOUND",
          "Recommendation is no longer current",
        );
      }
      await dismissSuggestion(ctx.db, {
        sourceEntityType: "product",
        sourceEntityId,
        suggestionKind: "product.related",
        candidateKey: await suggestionCandidateKey("product.related", [
          input.targetId,
        ]),
      });
      return { ok: true };
    }),
});
