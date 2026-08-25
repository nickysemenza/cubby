import { recipeRecomputeDurableEventSchema } from "@cubby/schemas/recipe";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { workflowStreamResponse } from "~/server/workflow-stream.server";
import { recomputeAllDurableWorkflow } from "~/server/workflows/recipe.server";

export const Route = createFileRoute("/api/recipe-stream/recompute-all")({
  server: {
    handlers: {
      POST: ({ request }) =>
        workflowStreamResponse({
          request,
          operation: "recipe.recomputeAllDurable",
          inputSchema: z.undefined(),
          eventSchema: recipeRecomputeDurableEventSchema,
          run: (context) =>
            recomputeAllDurableWorkflow(context.services.recipeCosting),
        }),
    },
  },
});
