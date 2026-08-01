import {
  relatedPreviewInput,
  relatedPreviewOutput,
} from "@cubby/schemas/related-view";
import { loadRelatedPreviews } from "~/server/repo/related-view";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const relatedDataRouter = createTRPCRouter({
  previews: protectedProcedure
    .input(relatedPreviewInput)
    .output(relatedPreviewOutput)
    .query(({ ctx, input }) => loadRelatedPreviews(ctx.db, input)),
});
