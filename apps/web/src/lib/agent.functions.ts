import type { agentAskInputSchema } from "@cubby/schemas/agent";
import type { z } from "zod";

import {
  agentContract,
  agentStreamsContract,
} from "~/contracts/agent.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const agent = defineOperationDomain(agentContract, {
  ask: { invalidates: ripple.none },
});
export const agentStreams = defineOperationDomain(agentStreamsContract);

export const askAgentStream = (
  input: z.input<typeof agentAskInputSchema>,
  signal?: AbortSignal,
) => agentStreams.askStream.open(input, { signal });
