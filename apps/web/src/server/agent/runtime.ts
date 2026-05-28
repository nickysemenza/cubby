import type { AgentResult, AgentSource } from "@cubby/schemas/agent";
import type { SearchableEntity } from "@cubby/schemas/search";
import { chat, maxIterations } from "@tanstack/ai";
import { getAnthropicClient } from "~/server/clients/anthropic";
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
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Pull the list of entity-like objects out of a (varied) tool result. */
function candidateObjects(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result.filter(isRecord);
  if (isRecord(result)) {
    for (const key of ["items", "results", "data", "locations", "products"]) {
      const value = result[key];
      if (Array.isArray(value)) return value.filter(isRecord);
    }
    return [result];
  }
  return [];
}

/**
 * Strip leading tool-use narration that Haiku emits between tool calls.
 * `chat({ stream: false })` concatenates assistant text across the whole agent
 * loop, so inter-tool narration ("Now let me check…") ends up glued to the
 * real answer. Proper fix is to consume the stream and keep only the final
 * turn's text; this is a safe stopgap that only removes a leading clause
 * starting with a narration verb, up to its first sentence/colon boundary.
 */
export function stripNarration(text: string): string {
  const narration =
    /^\s*(?:now\s+)?(?:let me|let's|i'll|i will|i'm going to|i am going to|first,?\s+let me|let me go ahead and)\b[^.:]*[.:]\s*/i;
  let out = text;
  // Haiku sometimes stacks two narration clauses (one per tool call).
  for (let i = 0; i < 3 && narration.test(out); i++) {
    out = out.replace(narration, "");
  }
  return out.trim().length > 0 ? out.trim() : text.trim();
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
      const product = isRecord(obj.product) ? obj.product : null;
      const location = isRecord(obj.location) ? obj.location : null;

      const id = typeof obj.id === "string" ? obj.id : null;
      const name =
        typeof obj.name === "string"
          ? obj.name
          : typeof product?.name === "string"
            ? product.name
            : null;
      if (!id || !name) continue;

      const key = `${entityType}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const detail =
        entityType === "inventory" && typeof location?.name === "string"
          ? location.name
          : typeof obj.manufacturer === "string"
            ? obj.manufacturer
            : typeof obj.parentName === "string"
              ? obj.parentName
              : null;

      sources.push({ entityType, id, name, detail });
      if (sources.length >= MAX_SOURCES) return sources;
    }
  }

  return sources;
}

/**
 * Run one agent turn: drive the @tanstack/ai tool-calling loop over the
 * read-only MCP toolset, then assemble a structured result with citations.
 */
export async function runAgent(
  // biome-ignore lint/suspicious/noExplicitAny: server-side tRPC caller
  caller: any,
  query: string,
): Promise<AgentResult> {
  const adapter = getAnthropicClient().getTextAdapter();
  const toolset = await createAgentToolset(caller);

  try {
    const answer = await chat({
      adapter,
      systemPrompts: [SYSTEM_PROMPT],
      messages: [{ role: "user", content: query }],
      tools: toolset.tools,
      agentLoopStrategy: maxIterations(5),
      stream: false,
    });

    return {
      answer: stripNarration(
        typeof answer === "string" ? answer : String(answer),
      ),
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
