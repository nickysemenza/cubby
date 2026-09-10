import {
  type AgentResult,
  type AgentSource,
  type AgentStreamEvent,
  agentSourceSchema,
} from "@cubby/schemas/agent";
import {
  type SearchableEntity,
  searchableEntitySchema,
} from "@cubby/schemas/search";
import { chat, maxIterations } from "@tanstack/ai";
import { type JSONType, z } from "zod";

import { DEFAULT_CHAT_MODEL } from "~/server/ai/models";
import { aiGatewayUsageMiddleware } from "~/server/clients/ai-gateway-usage";
import { getAnthropicClient } from "~/server/clients/anthropic";
import type { Database } from "~/server/db";

import type { createAgentToolset, ToolCallRecord } from "./mcp-bridge";

const SYSTEM_PROMPT = `You are Cubby's inventory assistant. Cubby is a personal home-inventory app that tracks products, inventory items, locations, recipes, and ingredients.

Answer the user's question by calling the available tools to look up real data.

Rules:
- Always ground answers in tool results. Never invent product names, locations, quantities, prices, or IDs.
- Use get_entities with a list, search, or get command for ordinary entities, and the specialized tools for recipe availability and shopping.
- CRITICAL: Never narrate tool use. Do not write "Now let me…", "I'll search…", "Let me check…", or any commentary about what you are about to do. Emit only the final answer to the user, nothing before it.
- Be concise: lead with the direct answer, then one short supporting detail.
- When saying where an item is, name its location.
- If you can't find something, say so plainly rather than guessing.`;

function inferEntityType(record: ToolCallRecord): SearchableEntity | null {
  const toolName = record.tool;
  if (toolName === "get_entities") {
    const command = entityReadArgsSchema.safeParse(record.args);
    return command.success ? command.data.command.entity : null;
  }
  if (toolName.includes("inventory")) return "inventory";
  if (toolName.includes("product")) return "product";
  if (toolName.includes("location")) return "location";
  if (toolName.includes("recipe")) return "recipe";
  if (toolName.includes("ingredient")) return "ingredient";
  // "project" after the food-domain checks: no current tool name collides,
  // but keep the more specific matches first.
  if (toolName.includes("project")) return "project";
  if (toolName.includes("task")) return "task";
  if (toolName.includes("expense")) return "expense";
  return null;
}

const sourceReferenceSchema = z.object({ name: z.string().optional() }).loose();
const sourceCandidateSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    manufacturer: z.string().optional(),
    product: sourceReferenceSchema.optional(),
    location: sourceReferenceSchema.optional(),
    parent: sourceReferenceSchema.optional(),
  })
  .loose();
const sourceCandidatesSchema = z.array(sourceCandidateSchema);
const sourceEnvelopeSchema = z
  .object({
    item: sourceCandidateSchema.nullable().optional(),
    items: sourceCandidatesSchema.optional(),
    results: sourceCandidatesSchema.optional(),
    data: sourceCandidatesSchema.optional(),
    locations: sourceCandidatesSchema.optional(),
    products: sourceCandidatesSchema.optional(),
    lexical: sourceCandidatesSchema.optional(),
    semantic: z.object({ results: sourceCandidatesSchema }).optional(),
  })
  .loose();
type SourceCandidate = z.output<typeof sourceCandidateSchema>;

/** Pull the list of entity-like objects out of a (varied) tool result. */
function candidateObjects(result: JSONType): SourceCandidate[] {
  const candidates = sourceCandidatesSchema.safeParse(result);
  if (candidates.success) return candidates.data;
  const envelope = sourceEnvelopeSchema.safeParse(result);
  if (envelope.success) {
    const grouped =
      envelope.data.items ??
      envelope.data.results ??
      envelope.data.data ??
      envelope.data.locations ??
      envelope.data.products;
    if (grouped) return grouped;
    if (envelope.data.item) return [envelope.data.item];
    if (envelope.data.lexical || envelope.data.semantic)
      return [
        ...(envelope.data.lexical ?? []),
        ...(envelope.data.semantic?.results ?? []),
      ];
  }
  const candidate = sourceCandidateSchema.safeParse(result);
  return candidate.success ? [candidate.data] : [];
}

const MAX_SOURCES = 12;
const entityReadArgsSchema = z.object({
  command: z.object({ entity: searchableEntitySchema }),
});

const sourceDetail = (
  entityType: SearchableEntity,
  candidate: SourceCandidate,
): string | null => {
  if (entityType === "inventory" && candidate.location?.name) {
    return candidate.location.name;
  }
  return candidate.manufacturer ?? candidate.parent?.name ?? null;
};

const sourceForCandidate = (
  entityType: SearchableEntity,
  candidate: SourceCandidate,
): AgentSource | null => {
  const id = candidate.id ?? null;
  const name = candidate.name ?? candidate.product?.name ?? null;
  if (!id || !name) return null;
  const parsed = agentSourceSchema.safeParse({
    entityType,
    id,
    name,
    detail: sourceDetail(entityType, candidate),
  });
  return parsed.success ? parsed.data : null;
};

/** Best-effort extraction of cited entities from the tools the agent ran. */
export function extractSources(records: ToolCallRecord[]): AgentSource[] {
  const sources: AgentSource[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    if (!record.ok) continue;
    const entityType = inferEntityType(record);
    if (!entityType) continue;

    for (const candidate of candidateObjects(record.result)) {
      const source = sourceForCandidate(entityType, candidate);
      if (!source) continue;
      const key = `${source.entityType}:${source.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(source);
      if (sources.length >= MAX_SOURCES) return sources;
    }
  }

  return sources;
}

/** The external chat adapter owns provider cancellation. Tool selection,
 * public event mapping, completion, and release belong to the workflow. */
export async function* streamAgentChat(
  db: Database,
  query: string,
  toolset: Awaited<ReturnType<typeof createAgentToolset>>,
  signal: AbortSignal,
) {
  const abortController = new AbortController();
  const abort = () => abortController.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    yield* chat({
      adapter: getAnthropicClient().getTextAdapter(),
      abortController,
      middleware: aiGatewayUsageMiddleware({
        db,
        feature: "agent-ask",
        provider: "anthropic",
        model: DEFAULT_CHAT_MODEL,
        operation: "runAgentStream",
        cacheStatus: "none",
      }),
      systemPrompts: [SYSTEM_PROMPT],
      messages: [{ role: "user", content: query }],
      tools: toolset.tools,
      agentLoopStrategy: maxIterations(5),
    });
  } finally {
    signal.removeEventListener("abort", abort);
    abortController.abort();
  }
}

/** The last tool call starts a new answer segment; provider narration before
 * that call must not appear in the non-streaming response. */
export async function collectAgentAnswer(
  events: AsyncIterable<AgentStreamEvent>,
): Promise<AgentResult> {
  let answer = "";
  let sources: AgentResult["sources"] = [];
  let toolCalls: AgentResult["toolCalls"] = [];
  for await (const event of events) {
    if (event.type === "delta") answer += event.text;
    else if (event.type === "tool") answer = "";
    else {
      sources = event.sources;
      toolCalls = event.toolCalls;
    }
  }
  return { answer: answer.trim(), sources, toolCalls };
}
