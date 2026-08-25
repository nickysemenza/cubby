import {
  aiEnrichmentProposalEventSchema,
  enrichmentProposalPrecomputeInput,
} from "@cubby/schemas/ai";
import { createFileRoute } from "@tanstack/react-router";
import { workflowStreamResponse } from "~/server/workflow-stream.server";
import { precomputeEnrichmentProposalsWorkflow } from "~/server/workflows/ai.server";

const post = ({ request }: { request: Request }) =>
  workflowStreamResponse({
    request,
    operation: "ai.precomputeEnrichmentProposals",
    inputSchema: enrichmentProposalPrecomputeInput,
    eventSchema: aiEnrichmentProposalEventSchema,
    run: (context, input) =>
      precomputeEnrichmentProposalsWorkflow(context, input),
  });

export const Route = createFileRoute(
  "/api/ai-stream/precompute-enrichment-proposals",
)({ server: { handlers: { POST: post } } });
