import { agent } from "~/lib/agent.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { askAgentWorkflow } from "~/server/workflows/agent.server";

export const agentHandlers = implementOperationDomain(agent, {
  ask: askAgentWorkflow,
});
