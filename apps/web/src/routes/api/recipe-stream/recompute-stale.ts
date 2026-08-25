import { recipeRecomputeDurableEventSchema } from "@cubby/schemas/recipe";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { workflowStreamResponse } from "~/server/workflow-stream.server";
import { recomputeStaleDurableWorkflow } from "~/server/workflows/recipe.server";

export const Route = createFileRoute("/api/recipe-stream/recompute-stale")({
  server: {
    handlers: {
      POST: ({ request }) =>
        workflowStreamResponse({
          request,
          operation: "recipe.recomputeStaleDurable",
          inputSchema: z.undefined(),
          eventSchema: recipeRecomputeDurableEventSchema,
          run: (context) =>
            recomputeStaleDurableWorkflow(context.services.recipeCosting),
        }),
    },
  },
});
