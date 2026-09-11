import {
  agentAskInputSchema,
  agentResultSchema,
  agentStreamEventSchema,
} from "@cubby/schemas/agent";

import { defineContract, mutation, subscription } from "~/contracts/define";

export const agentContract = defineContract("agent", {
  ask: mutation({
    input: agentAskInputSchema,
    output: agentResultSchema,
  }),
});

export const agentStreamsContract = defineContract("agent", {
  askStream: subscription({
    input: agentAskInputSchema,
    event: agentStreamEventSchema,
  }),
});
