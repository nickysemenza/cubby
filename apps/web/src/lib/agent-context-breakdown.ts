import type { FlueConversationMessage } from "@flue/sdk";
import { z } from "zod";

/**
 * Per-model-call context breakdown the purchase agent attaches to each Flue
 * response's metadata as `contextBreakdown` (apps/purchase-agent/src/
 * context-breakdown.ts). Section values are tokens scaled from request sizes
 * so they sum to the call's reported input tokens.
 */
const tokenCount = z.number().int().nonnegative();

const contextCallSchema = z.object({
  model: z.string().optional(),
  inputTokens: tokenCount,
  cachedTokens: tokenCount,
  estimated: z.boolean(),
  sections: z.object({
    instructions: tokenCount,
    agentToolSchemas: tokenCount,
    mcpToolSchemas: tokenCount,
    conversation: tokenCount,
    toolResults: z.record(z.string(), tokenCount),
  }),
});

const contextBreakdownSchema = z.object({
  v: z.literal(1),
  calls: z.array(contextCallSchema),
});

export type ContextCall = z.infer<typeof contextCallSchema>;

type MessageWithMetadata = Pick<
  FlueConversationMessage,
  "id" | "submissionId" | "metadata"
>;

/** Model calls in transcript order, one metadata block per response. */
export function contextCallsFromMessages(
  messages: readonly MessageWithMetadata[],
): ContextCall[] {
  const seen = new Set<string>();
  const calls: ContextCall[] = [];
  for (const message of messages) {
    const parsed = contextBreakdownSchema.safeParse(
      message.metadata?.contextBreakdown,
    );
    if (!parsed.success) continue;
    const response = message.submissionId ?? message.id;
    if (seen.has(response)) continue;
    seen.add(response);
    calls.push(...parsed.data.calls);
  }
  return calls;
}

type ContextSegment = { key: string; label: string };

export type ContextSummary = {
  segments: ContextSegment[];
  rows: Array<{
    call: number;
    inputTokens: number;
    cachedTokens: number;
    estimated: boolean;
    values: Record<string, number>;
  }>;
  maxTokens: number;
  topContributors: Array<{ label: string; share: number }>;
};

const FIXED_SEGMENTS = [
  { key: "instructions", label: "Instructions" },
  { key: "agentToolSchemas", label: "Agent tool schemas" },
  { key: "mcpToolSchemas", label: "MCP tool schemas" },
  { key: "conversation", label: "Conversation" },
] as const;
const OTHER_TOOLS = { key: "otherToolResults", label: "Other tool results" };

/** Drops Flue's `mcp__<server>__` prefix for display. */
const displayToolName = (name: string) => name.replace(/^mcp__.+?__/, "");

const toolKey = (name: string) => `tool:${name}`;

/**
 * Stacking segments (fixed sections, the largest tool results individually,
 * the rest grouped) and run-wide top contributors (every tool individually).
 */
export function summarizeContextCalls(
  calls: readonly ContextCall[],
  { topTools = 3, topContributors = 4 } = {},
): ContextSummary {
  const toolTotals = new Map<string, number>();
  for (const call of calls) {
    for (const [name, tokens] of Object.entries(call.sections.toolResults)) {
      toolTotals.set(name, (toolTotals.get(name) ?? 0) + tokens);
    }
  }
  const rankedTools = [...toolTotals.entries()]
    .filter(([, tokens]) => tokens > 0)
    .sort((a, b) => b[1] - a[1]);
  const shownTools = new Set(
    rankedTools.slice(0, topTools).map(([name]) => name),
  );
  const segments: ContextSegment[] = [
    ...FIXED_SEGMENTS,
    ...rankedTools
      .filter(([name]) => shownTools.has(name))
      .map(([name]) => ({
        key: toolKey(name),
        label: `${displayToolName(name)} results`,
      })),
    ...(rankedTools.length > shownTools.size ? [OTHER_TOOLS] : []),
  ];

  const rows = calls.map((call, index) => {
    const values: Record<string, number> = {};
    for (const { key } of FIXED_SEGMENTS) values[key] = call.sections[key];
    for (const [name, tokens] of Object.entries(call.sections.toolResults)) {
      const key = shownTools.has(name) ? toolKey(name) : OTHER_TOOLS.key;
      values[key] = (values[key] ?? 0) + tokens;
    }
    return {
      call: index + 1,
      inputTokens: call.inputTokens,
      cachedTokens: call.cachedTokens,
      estimated: call.estimated,
      values,
    };
  });

  const runTotal = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const contributors = [
    ...FIXED_SEGMENTS.map(({ key, label }) => ({
      label,
      tokens: rows.reduce((sum, row) => sum + (row.values[key] ?? 0), 0),
    })),
    ...rankedTools.map(([name, tokens]) => ({
      label: `${displayToolName(name)} results`,
      tokens,
    })),
  ]
    .filter((entry) => entry.tokens > 0)
    // Stable sort keeps fixed sections ahead of tools on ties.
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, topContributors)
    .map(({ label, tokens }) => ({
      label,
      share: runTotal ? Math.round((tokens / runTotal) * 100) : 0,
    }));

  return {
    segments,
    rows,
    maxTokens: Math.max(0, ...rows.map((row) => row.inputTokens)),
    topContributors: contributors,
  };
}
