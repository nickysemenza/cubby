import {
  captureAnalysisSchema,
  captureAnalyzeInputSchema,
} from "@cubby/schemas/capture";
import { getAnthropicClient } from "~/server/clients/anthropic";
import { getImageById } from "~/server/repo/image";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const captureRouter = createTRPCRouter({
  /**
   * Analyze an already-uploaded shelf photo with the vision model and return
   * proposed inventory items. Stateless — nothing is persisted; the client
   * holds the proposals through review and approves them via inventory.create.
   */
  analyze: protectedProcedure
    .input(captureAnalyzeInputSchema)
    .output(captureAnalysisSchema)
    .mutation(async ({ ctx, input }) => {
      const image = await getImageById(ctx.db, input.imageId);
      const detection = await getAnthropicClient().detectInventoryItems(
        [image.url],
        input.locationHint ?? "",
        [],
      );
      return {
        proposedItems: detection.items.map((item) => ({
          name: item.name,
          manufacturer: item.manufacturer,
          quantity: item.estimatedQuantity,
          unit: item.unit,
          confidence: item.confidence,
        })),
        summary: detection.summary,
      };
    }),
});
