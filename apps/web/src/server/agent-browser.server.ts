import { agent, agentStreams } from "~/lib/agent.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import {
  askAgentStreamWorkflow,
  askAgentWorkflow,
} from "~/server/workflows/agent.server";

export const agentHandlers = implementOperationDomain(agent, {
  ask: askAgentWorkflow,
});

export const agentStreamHandlers = implementSubscriptionDomain(agentStreams, {
  askStream: askAgentStreamWorkflow,
});
