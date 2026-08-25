import {
  agentAskInputSchema,
  agentResultSchema,
  agentStreamEventSchema,
} from "@cubby/schemas/agent";
import type { z } from "zod";
import { runAgent, runAgentStream } from "~/server/agent/runtime";
import { createMcpWorkflowCaller } from "~/server/mcp/workflow-caller";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";

export const agentWorkflowSchemas = {
  ask: { input: agentAskInputSchema, output: agentResultSchema },
  askStream: { input: agentAskInputSchema, output: agentStreamEventSchema },
} as const;

const createAgentCaller = (context: AuthenticatedStartOperationContext) =>
  createMcpWorkflowCaller({
    ...context,
    requestOrigin: "agent" as const,
    readDb: context.db,
    readConsistency: {
      consistency: "strong" as const,
      reason: "non-browser-origin" as const,
    },
  });

export const askAgentWorkflow = (
  context: AuthenticatedStartOperationContext,
  input: z.output<typeof agentAskInputSchema>,
) =>
  runAgent(
    createAgentCaller(context),
    context.db,
    context.actorContext.userId,
    input.query,
  );

export const askAgentStreamWorkflow = (
  context: AuthenticatedStartOperationContext,
  input: z.output<typeof agentAskInputSchema>,
) =>
  runAgentStream(
    createAgentCaller(context),
    context.db,
    context.actorContext.userId,
    input.query,
  );
