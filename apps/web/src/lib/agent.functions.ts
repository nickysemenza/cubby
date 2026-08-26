import {
  agentAskInputSchema,
  agentResultSchema,
  agentStreamEventSchema,
} from "@cubby/schemas/agent";
import type { z } from "zod";
import {
  defineOperationDomain,
  mutation,
} from "~/integrations/tanstack-query/operation-catalog";
import { openWorkflowStream } from "~/lib/workflow-stream";

export const agent = defineOperationDomain("agent", {
  ask: mutation({
    input: agentAskInputSchema,
    output: agentResultSchema,
    invalidates: [],
  }),
});
export const askAgentStream = (
  input: z.input<typeof agentAskInputSchema>,
  signal?: AbortSignal,
) =>
  openWorkflowStream({
    operation: "agent.askStream",
    kind: "mutation",
    url: "/api/agent-stream/ask",
    input,
    eventSchema: agentStreamEventSchema,
    signal,
  });
