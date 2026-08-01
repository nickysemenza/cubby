import {
  relatedPreviewInput,
  relatedPreviewOutput,
} from "@cubby/schemas/related-view";
import { loadRelatedPreviews } from "~/server/repo/related-view";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

export const relatedDataRouter = createTRPCRouter({
  previews: protectedProcedure
    .input(relatedPreviewInput)
    .output(strictOutput(relatedPreviewOutput))
    .query(({ ctx, input }) => loadRelatedPreviews(ctx.db, input)),
});
