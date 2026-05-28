import { z } from "zod";
import { searchableEntitySchema } from "./search";

/**
 * A cited entity the agent referenced while answering. Purpose-built for
 * citation rendering — lighter than the full SearchResultItem (the slimmed
 * tool outputs don't carry createdAt/imageUrl, and fabricating them is worse
 * than a minimal shape). Reuses `searchableEntitySchema` so the existing
 * entity icon/color infra applies via `entityTypeMap`.
 */
export const agentSourceSchema = z.object({
  entityType: searchableEntitySchema,
  id: z.string(),
  name: z.string(),
  /** Optional one-line context, e.g. "Paloform · milk-crate". */
  detail: z.string().nullable().optional(),
});
export type AgentSource = z.infer<typeof agentSourceSchema>;

/** Telemetry for one tool invocation during an agent run. */
export const agentToolCallSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  durationMs: z.number(),
  ok: z.boolean(),
});
export type AgentToolCall = z.infer<typeof agentToolCallSchema>;

/** Structured result of an `agent.ask` run. */
export const agentResultSchema = z.object({
  answer: z.string(),
  sources: z.array(agentSourceSchema),
  toolCalls: z.array(agentToolCallSchema),
});
export type AgentResult = z.infer<typeof agentResultSchema>;

/** Input for `agent.ask` / `agent.askStream`. */
export const agentAskInputSchema = z.object({
  query: z.string().min(1).max(1000),
});
export type AgentAskInput = z.infer<typeof agentAskInputSchema>;

/**
 * Events yielded by the streaming agent (`agent.askStream`).
 * - `tool`: a tool call started — the client should discard any text shown so
 *   far (it was inter-tool narration) and may show a "looking up…" status.
 * - `delta`: a chunk of answer text to append.
 * - `done`: terminal event carrying the cited sources + tool-call telemetry.
 */
export type AgentStreamEvent =
  | { type: "tool"; tool: string }
  | { type: "delta"; text: string }
  | { type: "done"; sources: AgentSource[]; toolCalls: AgentToolCall[] };
