import {
  agentAskInputSchema,
  agentResultSchema,
  agentStreamEventSchema,
} from "@cubby/schemas/agent";
import type { z } from "zod";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  subscription,
} from "~/integrations/tanstack-query/operation-catalog";

export const agent = defineOperationDomain("agent", {
  ask: mutation({
    input: agentAskInputSchema,
    output: agentResultSchema,
    invalidates: ripple.none,
  }),
});
export const agentStreams = defineOperationDomain("agent", {
  askStream: subscription({
    input: agentAskInputSchema,
    event: agentStreamEventSchema,
  }),
});

export const askAgentStream = (
  input: z.input<typeof agentAskInputSchema>,
  signal?: AbortSignal,
) => agentStreams.askStream.open(input, { signal });
