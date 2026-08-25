import { problemsReparseEventSchema } from "@cubby/schemas/problems";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { workflowStreamResponse } from "~/server/workflow-stream.server";
import { reparseStaleWorkflow } from "~/server/workflows/problems.server";

const post = ({ request }: { request: Request }) =>
  workflowStreamResponse({
    request,
    operation: "problems.reparseStale",
    inputSchema: z.undefined(),
    eventSchema: problemsReparseEventSchema,
    run: (context) => reparseStaleWorkflow(context),
  });

export const Route = createFileRoute("/api/problems-stream/reparse-stale")({
  server: { handlers: { POST: post } },
});
