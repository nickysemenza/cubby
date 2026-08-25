import { createFileRoute } from "@tanstack/react-router";
import { workflowStreamResponse } from "~/server/workflow-stream.server";
import {
  agentWorkflowSchemas,
  askAgentStreamWorkflow,
} from "~/server/workflows/agent.server";

const post = ({ request }: { request: Request }) =>
  workflowStreamResponse({
    request,
    operation: "agent.askStream",
    inputSchema: agentWorkflowSchemas.askStream.input,
    eventSchema: agentWorkflowSchemas.askStream.output,
    workload: "import-stream",
    run: (context, input) => askAgentStreamWorkflow(context, input),
  });

export const Route = createFileRoute("/api/agent-stream/ask")({
  server: { handlers: { POST: post } },
});
