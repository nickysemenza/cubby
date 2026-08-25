import {
  cookbookImportEventSchema,
  importCookbookStreamInput,
} from "@cubby/schemas/import-recipe";
import { createFileRoute } from "@tanstack/react-router";
import { workflowStreamResponse } from "~/server/workflow-stream.server";
import { importCookbookWorkflow } from "~/server/workflows/recipe-import.server";

export const Route = createFileRoute("/api/recipe-stream/import-cookbook")({
  server: {
    handlers: {
      POST: ({ request }) =>
        workflowStreamResponse({
          request,
          operation: "recipe.importCookbookStream",
          inputSchema: importCookbookStreamInput,
          eventSchema: cookbookImportEventSchema,
          run: importCookbookWorkflow,
        }),
    },
  },
});
