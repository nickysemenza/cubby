import {
  type AgentResult,
  type AgentSource,
  type AgentStreamEvent,
  agentSourceSchema,
} from "@cubby/schemas/agent";
import type { UserId } from "@cubby/schemas/identifiers";
import type { SearchableEntity } from "@cubby/schemas/search";
import { chat, maxIterations } from "@tanstack/ai";
import { type JSONType, z } from "zod";

import { DEFAULT_CHAT_MODEL } from "~/server/ai/models";
import { aiGatewayUsageMiddleware } from "~/server/clients/ai-gateway-usage";
import { getAnthropicClient } from "~/server/clients/anthropic";
import type { Database } from "~/server/db";
import type { McpWorkflowCaller } from "~/server/mcp/workflow-caller";

import { createAgentToolset, type ToolCallRecord } from "./mcp-bridge";

const SYSTEM_PROMPT = `You are Cubby's inventory assistant. Cubby is a personal home-inventory app that tracks products, inventory items, locations, recipes, and ingredients.

Answer the user's question by calling the available tools to look up real data.

Rules:
- Always ground answers in tool results. Never invent product names, locations, quantities, prices, or IDs.
- Use search_* and list_* tools to find things; use get_* tools for details.
- CRITICAL: Never narrate tool use. Do not write "Now let me…", "I'll search…", "Let me check…", or any commentary about what you are about to do. Emit only the final answer to the user, nothing before it.
- Be concise: lead with the direct answer, then one short supporting detail.
- When saying where an item is, name its location.
- If you can't find something, say so plainly rather than guessing.`;

function inferEntityType(toolName: string): SearchableEntity | null {
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
    items: sourceCandidatesSchema.optional(),
    results: sourceCandidatesSchema.optional(),
    data: sourceCandidatesSchema.optional(),
    locations: sourceCandidatesSchema.optional(),
    products: sourceCandidatesSchema.optional(),
  })
  .loose();
type SourceCandidate = z.output<typeof sourceCandidateSchema>;

/** Pull the list of entity-like objects out of a (varied) tool result. */
function candidateObjects(result: JSONType): SourceCandidate[] {
  const candidates = sourceCandidatesSchema.safeParse(result);
  if (candidates.success) return candidates.data;
  const envelope = sourceEnvelopeSchema.safeParse(result);
  if (envelope.success) {
    return (
      envelope.data.items ??
      envelope.data.results ??
      envelope.data.data ??
      envelope.data.locations ??
      envelope.data.products ??
      []
    );
  }
  const candidate = sourceCandidateSchema.safeParse(result);
  return candidate.success ? [candidate.data] : [];
}

const MAX_SOURCES = 12;

/** Best-effort extraction of cited entities from the tools the agent ran. */
export function extractSources(records: ToolCallRecord[]): AgentSource[] {
  const sources: AgentSource[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    if (!record.ok) continue;
    const entityType = inferEntityType(record.tool);
    if (!entityType) continue;

    for (const obj of candidateObjects(record.result)) {
      const product = obj.product ?? null;
      const location = obj.location ?? null;
      // A location row names its parent through a nested `{id,name,type}` ref
      // (`locationMcpOut` picks it straight off the plain shape), not a
      // flattened `parentName`.
      const parent = obj.parent ?? null;

      const id = obj.id ?? null;
      const name = obj.name ?? product?.name ?? null;
      if (!id || !name) continue;

      const key = `${entityType}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const detail =
        entityType === "inventory" && location?.name
          ? location.name
          : obj.manufacturer
            ? obj.manufacturer
            : parent?.name
              ? parent.name
              : null;

      const parsed = agentSourceSchema.safeParse({
        entityType,
        id,
        name,
        detail,
      });
      if (!parsed.success) continue;
      sources.push(parsed.data);
      if (sources.length >= MAX_SOURCES) return sources;
    }
  }

  return sources;
}

/**
 * Drive the @tanstack/ai tool-calling loop over the read-only MCP toolset,
 * yielding stream events as they happen.
 *
 * The agent loop emits ordered parts — [text(narration), tool-call,
 * tool-result, text(answer)] — where TOOL_CALL_START separates segments. We
 * forward text deltas and tool-call starts; consumers reset accumulated text
 * on each `tool` event so only the post-final-tool text survives as the answer
 * (a plain `stream: false` would concatenate every segment, narration included).
 */
export async function* runAgentStream(
  caller: McpWorkflowCaller,
  db: Database,
  userId: UserId,
  query: string,
): AsyncGenerator<AgentStreamEvent> {
  const adapter = getAnthropicClient().getTextAdapter();
  const toolset = await createAgentToolset(caller, db, userId);

  try {
    const stream = chat({
      adapter,
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

    for await (const chunk of stream) {
      if (chunk.type === "TEXT_MESSAGE_CONTENT") {
        yield { type: "delta", text: chunk.delta ?? "" };
      } else if (chunk.type === "TOOL_CALL_START") {
        yield { type: "tool", tool: chunk.toolCallName ?? "" };
      }
    }

    yield {
      type: "done",
      sources: extractSources(toolset.records),
      toolCalls: toolset.records.map((record) => ({
        tool: record.tool,
        args: record.args,
        durationMs: record.durationMs,
        ok: record.ok,
      })),
    };
  } finally {
    await toolset.close();
  }
}

/**
 * Non-streaming convenience: collect {@link runAgentStream} into a final
 * {@link AgentResult}. Applies the same segment-reset logic (drop text before
 * each tool call) so the answer is the post-final-tool text.
 */
export async function runAgent(
  caller: McpWorkflowCaller,
  db: Database,
  userId: UserId,
  query: string,
): Promise<AgentResult> {
  let answer = "";
  let sources: AgentResult["sources"] = [];
  let toolCalls: AgentResult["toolCalls"] = [];

  for await (const event of runAgentStream(caller, db, userId, query)) {
    if (event.type === "delta") {
      answer += event.text;
    } else if (event.type === "tool") {
      answer = "";
    } else {
      sources = event.sources;
      toolCalls = event.toolCalls;
    }
  }

  return { answer: answer.trim(), sources, toolCalls };
}
