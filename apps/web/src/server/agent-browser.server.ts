import type { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  agentWorkflowSchemas,
  askAgentWorkflow,
} from "~/server/workflows/agent.server";

export const askAgentForBrowser = (options: {
  data: z.input<typeof agentWorkflowSchemas.ask.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "agent.ask",
    type: "mutation",
    input: options.data,
    inputSchema: agentWorkflowSchemas.ask.input,
    outputSchema: agentWorkflowSchemas.ask.output,
    request: options.request,
    run: askAgentWorkflow,
  });
