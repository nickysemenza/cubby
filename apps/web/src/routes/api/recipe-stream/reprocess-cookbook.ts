import {
  cookbookIdInput,
  cookbookReprocessEventSchema,
} from "@cubby/schemas/import-recipe";
import { createFileRoute } from "@tanstack/react-router";
import { workflowStreamResponse } from "~/server/workflow-stream.server";
import { reprocessCookbookWorkflow } from "~/server/workflows/recipe-import.server";

export const Route = createFileRoute("/api/recipe-stream/reprocess-cookbook")({
  server: {
    handlers: {
      POST: ({ request }) =>
        workflowStreamResponse({
          request,
          operation: "recipe.reprocessCookbook",
          inputSchema: cookbookIdInput,
          eventSchema: cookbookReprocessEventSchema,
          run: reprocessCookbookWorkflow,
        }),
    },
  },
});
