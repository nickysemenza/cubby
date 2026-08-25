import { z } from "zod";
import { searchableEntityIdSchema, searchableEntitySchema } from "./search";

/**
 * A cited entity the agent referenced while answering. Purpose-built for
 * citation rendering — lighter than a generic SearchHit (the slimmed
 * tool outputs don't carry createdAt/imageUrl, and fabricating them is worse
 * than a minimal shape). Reuses `searchableEntitySchema` so the existing
 * entity icon/color infra applies via `entityTypeMap`.
 */
export const agentSourceSchema = z.object({
  entityType: searchableEntitySchema,
  id: searchableEntityIdSchema,
  name: z.string(),
  detail: z.string().nullable().optional(),
});
export type AgentSource = z.infer<typeof agentSourceSchema>;

export const agentToolCallSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.json()),
  durationMs: z.number(),
  ok: z.boolean(),
});
export type AgentToolCall = z.infer<typeof agentToolCallSchema>;

export const agentResultSchema = z.object({
  answer: z.string(),
  sources: z.array(agentSourceSchema),
  toolCalls: z.array(agentToolCallSchema),
});
export type AgentResult = z.infer<typeof agentResultSchema>;

export const agentAskInputSchema = z.object({
  query: z.string().min(1).max(1000),
});
export type AgentAskInput = z.infer<typeof agentAskInputSchema>;

export const agentStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool"), tool: z.string() }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({
    type: z.literal("done"),
    sources: z.array(agentSourceSchema),
    toolCalls: z.array(agentToolCallSchema),
  }),
]);
export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;
