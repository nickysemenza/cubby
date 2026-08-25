import { aiBackfillLocationDescriptionsEventSchema } from "@cubby/schemas/ai";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { workflowStreamResponse } from "~/server/workflow-stream.server";
import { backfillLocationDescriptionsWorkflow } from "~/server/workflows/ai.server";

const post = ({ request }: { request: Request }) =>
  workflowStreamResponse({
    request,
    operation: "ai.backfillLocationDescriptions",
    inputSchema: z.undefined(),
    eventSchema: aiBackfillLocationDescriptionsEventSchema,
    run: (context) => backfillLocationDescriptionsWorkflow(context.db),
  });

export const Route = createFileRoute(
  "/api/ai-stream/backfill-location-descriptions",
)({ server: { handlers: { POST: post } } });
