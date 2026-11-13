import { z } from "zod";

import { defineAsk } from "~/server/kernel/api";

const agentTurnResponse = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

/** The host supplies the producer while its durable Pi task is executing. */
export const agentTurnAsk = defineAsk({
  feature: "purchase.agent-turn",
  producer: "model",
  hosted: true,
  promptVersion: "1",
  input: z.object({
    runId: z.uuid(),
    generation: z.string(),
    request: z.json(),
  }),
  output: agentTurnResponse,
});
