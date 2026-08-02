import {
  relatedBranchInput,
  relatedBranchOutput,
  relatedMatchesInput,
  relatedMatchesOutput,
  relatedOptionsInput,
  relatedOptionsOutput,
  relatedPreviewInput,
  relatedPreviewOutput,
} from "@cubby/schemas/related-view";
import {
  loadRelatedBranch,
  loadRelatedMatches,
  loadRelatedOptions,
  loadRelatedPreviews,
} from "~/server/repo/related-view";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

export const relatedDataRouter = createTRPCRouter({
  previews: protectedProcedure
    .input(relatedPreviewInput)
    .output(strictOutput(relatedPreviewOutput))
    .query(({ ctx, input }) => loadRelatedPreviews(ctx.db, input)),
  branch: protectedProcedure
    .input(relatedBranchInput)
    .output(strictOutput(relatedBranchOutput))
    .query(({ ctx, input }) => loadRelatedBranch(ctx.db, input)),
  options: protectedProcedure
    .input(relatedOptionsInput)
    .output(strictOutput(relatedOptionsOutput))
    .query(({ ctx, input }) => loadRelatedOptions(ctx.db, input)),
  matches: protectedProcedure
    .input(relatedMatchesInput)
    .output(strictOutput(relatedMatchesOutput))
    .query(({ ctx, input }) => loadRelatedMatches(ctx.db, input)),
});
