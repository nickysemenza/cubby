import {
  importNotionSyncInput,
  notionImportEventSchema,
} from "@cubby/schemas/import-recipe";
import { createFileRoute } from "@tanstack/react-router";
import { workflowStreamResponse } from "~/server/workflow-stream.server";
import { importNotionSyncWorkflow } from "~/server/workflows/recipe-import.server";

export const Route = createFileRoute("/api/recipe-stream/import-notion")({
  server: {
    handlers: {
      POST: ({ request }) =>
        workflowStreamResponse({
          request,
          operation: "recipe.importNotionSyncStream",
          inputSchema: importNotionSyncInput,
          eventSchema: notionImportEventSchema,
          run: importNotionSyncWorkflow,
        }),
    },
  },
});
