import {
  agentContract,
  agentStreamsContract,
} from "~/contracts/agent.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import {
  askAgentStreamWorkflow,
  askAgentWorkflow,
} from "~/server/workflows/agent.server";

export const agentHandlers = implementOperationDomain(agentContract, {
  ask: askAgentWorkflow,
});

export const agentStreamHandlers = implementSubscriptionDomain(
  agentStreamsContract,
  {
    askStream: askAgentStreamWorkflow,
  },
);
