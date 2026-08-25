import { problemsPruneAliasesEventSchema } from "@cubby/schemas/problems";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { workflowStreamResponse } from "~/server/workflow-stream.server";
import { pruneAllUnusedAliasesWorkflow } from "~/server/workflows/problems.server";

const post = ({ request }: { request: Request }) =>
  workflowStreamResponse({
    request,
    operation: "problems.pruneAllUnusedAliases",
    inputSchema: z.undefined(),
    eventSchema: problemsPruneAliasesEventSchema,
    run: (context) => pruneAllUnusedAliasesWorkflow(context),
  });

export const Route = createFileRoute(
  "/api/problems-stream/prune-unused-aliases",
)({ server: { handlers: { POST: post } } });
