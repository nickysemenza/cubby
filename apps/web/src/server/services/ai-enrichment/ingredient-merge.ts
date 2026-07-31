// ---------------------------------------------------------------------------
// AI-assisted ingredient merge suggestions
//
// EPUB imports create near-duplicate ingredients that string matching can't
// catch (scallion≈green onion, cilantro≈coriander, garbanzo≈chickpea). Same
// agentic loop as the USDA matcher: a search tool over existing ingredients + a
// terminal select tool, with a `seen` map so the model can only target an id it
// actually saw. Suggestions only — merge is destructive, so the user confirms.
// ---------------------------------------------------------------------------

import type { Confidence } from "@cubby/schemas/ai";
import {
  type IngredientId,
  type IngredientShortcode,
  unsafeIngredientShortcode,
} from "@cubby/schemas/identifiers";
import { chat, maxIterations, toolDefinition } from "@tanstack/ai";
import { DEFAULT_CHAT_MODEL } from "~/server/ai/models";
import { aiGatewayUsageMiddleware } from "~/server/clients/ai-gateway-usage";
import { getAnthropicClient } from "~/server/clients/anthropic";
import type { Database } from "~/server/db";
import { searchIngredientsForMerge } from "~/server/repo/ingredient";
import { drainChat, IS_CF_WORKERS } from "./shared";

export interface IngredientMergeSuggestion {
  target: {
    id: IngredientId;
    shortcode: IngredientShortcode;
    name: string;
  } | null;
  confidence: Confidence;
  reasoning: string;
}

function buildMergePrompt(): string {
  return `You decide whether a recipe ingredient is the SAME purchasable item as an existing ingredient, so the two can be merged (deduplicated).

Merge ONLY when they are the same thing you would buy — synonyms, alternate names, or spelling/case variants. Examples to merge: scallion = green onion; cilantro = coriander (leaf); garbanzo beans = chickpeas; confectioners' sugar = powdered sugar.

NEVER merge distinct variants a cook treats differently: light vs dark brown sugar; whole vs 2% milk; salted vs unsalted butter; fresh vs dried herbs.

Tools:
- search_ingredients(query): existing ingredients by name, as "id [N products]: name". Prefer a target that already has products — the merge inherits them.
- select_merge_target(ingredientId, confidence, reasoning): your decision. ingredientId must be an id from a search result, or null if there is no genuine duplicate. Call exactly once.

Default to null when unsure. A wrong merge is destructive, so be conservative.`;
}

/**
 * Suggest an existing ingredient to merge a bare/imported one into. Read-only —
 * returns a candidate (or null) for the user to confirm; merges nothing.
 */
export async function suggestIngredientMerge(
  db: Database,
  source: { id: IngredientId; name: string },
): Promise<IngredientMergeSuggestion> {
  const adapter = getAnthropicClient().getTextAdapter({
    feature: "ingredient-merge",
    ingredient: source.name,
    env: IS_CF_WORKERS ? "prod" : "dev",
  });

  const seen = new Map<
    string,
    { id: IngredientId; shortcode: IngredientShortcode; name: string }
  >();
  const state: {
    selection: {
      ingredientId: string | null;
      confidence: Confidence;
      reasoning: string;
    } | null;
  } = { selection: null };

  // Run one ingredient search: record every hit in `seen` (so a later select can
  // only target an id the model actually saw) and format for the model. Shared
  // by the search tool and the up-front pre-seed below.
  const runSearch = async (query: string): Promise<string> => {
    const rows = await searchIngredientsForMerge(db, query, source.id, 12);
    for (const r of rows)
      seen.set(r.id, {
        id: r.id,
        shortcode: unsafeIngredientShortcode(r.shortcode),
        name: r.name,
      });
    if (rows.length === 0) return "No results.";
    return rows
      .map((r) => `${r.id} [${r.productCount} products]: ${r.name}`)
      .join("\n");
  };

  const searchTool = toolDefinition({
    name: "search_ingredients",
    description:
      "Search existing ingredients by name. Returns up to 12 candidates as `id [N products]: name`.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Name to search" } },
      required: ["query"],
    },
  }).server(async (rawArgs) => {
    const args = (rawArgs ?? {}) as { query?: string };
    if (!args.query) return "Provide a query.";
    return runSearch(args.query);
  });

  const selectTool = toolDefinition({
    name: "select_merge_target",
    description:
      "Record your decision. Call exactly once. ingredientId must come from a search result, or null if there is no genuine duplicate.",
    inputSchema: {
      type: "object",
      properties: {
        ingredientId: { type: ["string", "null"] },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        reasoning: { type: "string" },
      },
      required: ["ingredientId", "confidence", "reasoning"],
    },
  }).server(async (rawArgs) => {
    const args = (rawArgs ?? {}) as {
      ingredientId?: string | null;
      confidence?: Confidence;
      reasoning?: string;
    };
    state.selection = {
      ingredientId: args.ingredientId ?? null,
      confidence: args.confidence ?? "low",
      reasoning: args.reasoning ?? "",
    };
    return "Recorded.";
  });

  // Pre-seed the obvious name search server-side so the model can decide on turn
  // 1 in the common case (search_ingredients stays available to refine).
  const initialResults = await runSearch(source.name);

  const stream = chat({
    adapter,
    middleware: aiGatewayUsageMiddleware({
      db,
      feature: "ingredient-merge",
      provider: "anthropic",
      model: DEFAULT_CHAT_MODEL,
      operation: "suggestIngredientMerge",
      cacheStatus: "none",
      entity: { entityType: "ingredient", entityId: source.id },
    }),
    systemPrompts: [buildMergePrompt()],
    messages: [
      {
        role: "user",
        content: `Is the recipe ingredient "${source.name}" the same purchasable item as an existing ingredient?

Existing ingredients matching "${source.name}":
${initialResults}

If one is a genuine duplicate, call select_merge_target now. Otherwise search_ingredients to look wider, then call select_merge_target (null if there is no real duplicate).`,
      },
    ],
    tools: [searchTool, selectTool],
    agentLoopStrategy: maxIterations(6),
  });
  await drainChat(stream, "suggestIngredientMerge");

  const { selection } = state;
  if (!selection || selection.ingredientId == null) {
    return {
      target: null,
      confidence: selection?.confidence ?? "low",
      reasoning: selection?.reasoning || "No duplicate found.",
    };
  }
  // Only honor an id the model actually saw (anti-hallucination).
  return {
    target: seen.get(selection.ingredientId) ?? null,
    confidence: selection.confidence,
    reasoning: selection.reasoning,
  };
}

interface IngredientMergeBatchSuggestion extends IngredientMergeSuggestion {
  source: { id: IngredientId; shortcode: IngredientShortcode; name: string };
}

/** Batch {@link suggestIngredientMerge} for the workbench's "Suggest merges". */
export async function suggestIngredientMergeBatch(
  db: Database,
  sources: { id: IngredientId; shortcode: IngredientShortcode; name: string }[],
): Promise<IngredientMergeBatchSuggestion[]> {
  const capped = sources.slice(0, 20);
  const out: IngredientMergeBatchSuggestion[] = [];
  for (let i = 0; i < capped.length; i += 5) {
    const batch = capped.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map((s) => suggestIngredientMerge(db, s)),
    );
    results.forEach((result, j) => {
      const source = batch[j]!;
      if (result.status === "fulfilled") {
        out.push({ source, ...result.value });
      } else {
        console.error(
          `[suggestIngredientMergeBatch] ${source.name} failed:`,
          result.reason,
        );
        out.push({
          source,
          target: null,
          confidence: "low",
          reasoning: "Lookup failed.",
        });
      }
    });
  }
  return out;
}
