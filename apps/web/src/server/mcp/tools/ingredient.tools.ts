import {
  ingredientFiltersSchema,
  ingredientMcpListOut,
  ingredientMcpOut,
  ingredientMergeBatchInput,
  ingredientMergeBatchOut,
  ingredientRawLinesBatchOut,
  ingredientResolvableNamesInput,
  ingredientResolveOrCreateResponseOut,
  type MergeSummaryOut,
  mcpIngredientCreateInput,
  mcpIngredientUpdateInput,
} from "@cubby/schemas/ingredient";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { groupBy } from "es-toolkit";
import { z } from "zod";
import {
  formatToolError,
  getCaller,
  READ_ONLY_CLOSED,
  registerEntityCreateTool,
  registerEntityDeleteTool,
  registerEntityGetTool,
  registerEntityListTool,
  registerEntityUpdateTool,
  registerMcpTool,
  registerRouterTool,
  slimIngredient,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
  withIdInput,
} from "./_shared";

export function registerIngredientTools(server: McpServer) {
  registerEntityListTool(server, {
    name: "search_ingredients",
    description:
      "Search ingredients by name. Returns id, name, aliases, linked products, and recipe count.",
    router: "ingredient",
    filtersSchema: ingredientFiltersSchema,
    outputSchema: ingredientMcpListOut,
    slim: slimIngredient,
    sort: { orderBy: "name" },
    annotations: READ_ONLY_CLOSED,
  });

  registerEntityGetTool(server, {
    name: "get_ingredient",
    description:
      "Get a single ingredient by ID, including linked products and recipes it appears in.",
    router: "ingredient",
    idLabel: "Ingredient",
    outputSchema: ingredientMcpOut,
    slim: slimIngredient,
    annotations: READ_ONLY_CLOSED,
  });

  registerEntityCreateTool(server, {
    name: "create_ingredient",
    description:
      "Create a new ingredient. Use search_ingredients first to avoid duplicates.",
    inputSchema: mcpIngredientCreateInput.shape,
    outputSchema: ingredientMcpOut,
    slim: slimIngredient,
    annotations: WRITE_CLOSED,
    create: (caller, params) =>
      caller.ingredient.create({
        name: params.name,
        aliases: params.aliases ?? [],
      }),
  });

  registerRouterTool(server, {
    name: "resolve_ingredients",
    description:
      "Batch-resolve a list of ingredient names to IDs in one call: each name is matched to an existing ingredient (case-insensitive, including aliases) or created if missing.",
    inputSchema: ingredientResolvableNamesInput.shape,
    outputSchema: ingredientResolveOrCreateResponseOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) =>
      caller.ingredient
        .resolveOrCreate({ names: params.names })
        .then((results: unknown) => ({
          results,
        })),
  });

  registerEntityUpdateTool(server, {
    name: "update_ingredient",
    description: "Update an ingredient's name or aliases.",
    inputSchema: withIdInput("Ingredient", mcpIngredientUpdateInput.shape),
    outputSchema: ingredientMcpOut,
    slim: slimIngredient,
    router: "ingredient",
    annotations: WRITE_CLOSED,
  });

  registerMcpTool(server, {
    name: "merge_ingredients",
    description:
      "Merge one or more clusters of duplicate ingredients in a single call.",
    inputSchema: ingredientMergeBatchInput.shape,
    outputSchema: ingredientMergeBatchOut,
    annotations: WRITE_DESTRUCTIVE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const merges = params.merges as Array<{
        target: string;
        aliases: string[];
      }>;
      const dryRun = params.dryRun as boolean | undefined;
      const results: Array<{
        target: string;
        ok: boolean;
        summary?: MergeSummaryOut;
        error?: string;
      }> = [];
      for (const { target, aliases } of merges) {
        try {
          const result = await caller.ingredient.merge({
            target,
            aliases,
            dryRun,
          });
          results.push({ target, ok: true, summary: result.mergeSummary });
        } catch (error) {
          results.push({ target, ok: false, error: formatToolError(error) });
        }
      }
      return {
        merged: results.filter((r) => r.ok).length,
        total: results.length,
        results,
      };
    },
  });

  registerEntityDeleteTool(server, {
    name: "delete_ingredients",
    description:
      "Soft-delete ingredients by IDs. Fails if an ingredient is used in recipes or linked to products.",
    router: "ingredient",
    entityLabel: "ingredient",
    annotations: WRITE_DESTRUCTIVE_CLOSED,
  });

  registerMcpTool(server, {
    name: "get_ingredient_raw_lines",
    description:
      "Bulk parser-triage dump: for each ingredient id, the original rawLine of every recipe line currently linked to it.",
    inputSchema: {
      ids: z
        .array(z.string())
        .min(1)
        .describe("Ingredient IDs to dump raw lines for"),
    },
    outputSchema: ingredientRawLinesBatchOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const rows = (await caller.ingredient.rawLines({
        ids: params.ids,
      })) as Array<{
        ingredientId: string;
        lineId: string;
        rawLine: string | null;
        modifier: string | null;
        amounts: unknown[];
        recipeId: string;
        recipeName: string;
        sectionName: string | null;
      }>;
      const byIngredient = groupBy(rows, (r) => r.ingredientId);
      const ingredients = Object.entries(byIngredient).map(
        ([ingredientId, lines]) => ({
          ingredientId,
          lineCount: lines.length,
          lines: lines.map((l) => ({
            lineId: l.lineId,
            rawLine: l.rawLine,
            modifier: l.modifier,
            amounts: l.amounts,
            recipeId: l.recipeId,
            recipeName: l.recipeName,
            sectionName: l.sectionName,
          })),
        }),
      );
      return { count: ingredients.length, ingredients };
    },
  });
}
