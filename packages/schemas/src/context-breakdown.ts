import { z } from "zod";

/**
 * Per-model-call context breakdown the purchase agent attaches to each Flue
 * response's metadata as `contextBreakdown` (writer:
 * apps/purchase-agent/src/context-breakdown.ts; reader:
 * apps/web/src/lib/agent-context-breakdown.ts). Section values are tokens
 * scaled from request sizes so they sum to the call's reported input tokens.
 */
const tokenCount = z.number().int().nonnegative();

export const contextSectionsSchema = z.object({
  instructions: tokenCount,
  agentToolSchemas: tokenCount,
  mcpToolSchemas: tokenCount,
  conversation: tokenCount,
  /** Keyed by the tool name the model called (MCP names keep their prefix). */
  toolResults: z.record(z.string(), tokenCount),
});

export const contextCallSchema = z.object({
  model: z.string().optional(),
  /** Reported input tokens, including cached ones. */
  inputTokens: tokenCount,
  cachedTokens: tokenCount,
  /** True when the provider reported no usage and tokens are chars / 4. */
  estimated: z.boolean(),
  /** Token counts that sum exactly to `inputTokens`. */
  sections: contextSectionsSchema,
});

export const contextBreakdownSchema = z.object({
  v: z.literal(1),
  calls: z.array(contextCallSchema),
});

export type ContextSections = z.infer<typeof contextSectionsSchema>;
export type ContextCall = z.infer<typeof contextCallSchema>;
export type ContextBreakdown = z.infer<typeof contextBreakdownSchema>;
