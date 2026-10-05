import { z } from "zod";

import { contextBreakdownSchema } from "./context-breakdown";

/**
 * The import-run agent conversation as the web app reads it. The purchase
 * agent projects its durable pi transcript (entries plus the live generation
 * and tool round) into this shape (writer:
 * apps/web/src/server/purchase-agent/conversation.ts); the run page renders it (reader:
 * apps/web/src/app/runs/agent-observation.ts). Cubby owns this contract so the
 * web app never depends on the harness's own types.
 *
 * Wire: `GET …/agent` returns one snapshot; `GET …/agent/stream` is SSE whose
 * every `data:` line is a whole snapshot (latest wins, no deltas to apply).
 */
const jsonValue = z.json();

const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});

export const agentConversationPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  /** Image content; the bytes stay in the agent's transcript. */
  z.object({
    type: z.literal("file"),
    mediaType: z.string(),
    filename: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool"),
    toolCallId: z.string(),
    /** As the model called it; MCP tools keep their `mcp__cubby__` prefix. */
    toolName: z.string(),
    state: z.enum(["input-available", "output-available", "output-error"]),
    input: jsonValue,
    output: jsonValue.optional(),
    errorText: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
]);

export const agentConversationMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "signal"]),
  /** A short label for the transcript row (`member`, `coordinator`, …). */
  purpose: z.string(),
  /** Human-readable timestamp of the entry. */
  display: z.string(),
  createdAt: z.string(),
  /** Present on `signal` rows: the queue event or nudge that woke the agent. */
  signal: z
    .object({
      type: z.string(),
      attributes: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  /** Present on assistant rows. */
  metadata: z
    .object({
      model: z.string().optional(),
      usage: usageSchema.optional(),
      contextBreakdown: contextBreakdownSchema.optional(),
    })
    .optional(),
  parts: z.array(agentConversationPartSchema),
});

export const agentConversationSettlementSchema = z.object({
  operationId: z.string(),
  outcome: z.enum(["done", "unanswered"]),
  reason: z.string().optional(),
});

export const agentConversationSchema = z.object({
  /**
   * `absent`: no run has been dispatched to this agent yet. `idle`: nothing
   * is running. `running`: a model turn or tool round is in flight.
   */
  status: z.enum(["absent", "idle", "running"]),
  messages: z.array(agentConversationMessageSchema),
  settlements: z.array(agentConversationSettlementSchema),
});

export type AgentConversationPart = z.infer<typeof agentConversationPartSchema>;
export type AgentConversationMessage = z.infer<
  typeof agentConversationMessageSchema
>;
export type AgentConversationSettlement = z.infer<
  typeof agentConversationSettlementSchema
>;
export type AgentConversation = z.infer<typeof agentConversationSchema>;

/** A member's prompt to a live run (`POST …/agent`). */
export const agentPromptSchema = z.object({
  kind: z.literal("user"),
  body: z.string().trim().min(1).max(4_000),
});
