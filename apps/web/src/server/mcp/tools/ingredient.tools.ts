import {
  ingredientFilterFields,
  ingredientMcpListOut,
  ingredientMcpOut,
  ingredientMergeBatchInput,
  ingredientMergeBatchOut,
  ingredientRawLinesBatchOut,
  ingredientResolvableNamesInput,
  ingredientResolveOrCreateResponseOut,
  ingredientUpdateData,
  type MergeSummaryOut,
  mcpIngredientCreateInput,
} from "@cubby/schemas/ingredient";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { groupBy } from "es-toolkit";
import { z } from "zod";
import {
  formatToolError,
  getCaller,
  idParam,
  READ_ONLY_CLOSED,
  registerEntityCrudToolset,
  registerMcpTool,
  registerRouterTool,
  slimIngredient,
  structuredSuccessWithError,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
} from "./_shared";

export function registerIngredientTools(server: McpServer) {
  registerEntityCrudToolset(server, {
    entity: "ingredient",
    names: { list: "search_ingredients" },
    createInput: mcpIngredientCreateInput.shape,
    updateShape: ingredientUpdateData.shape,
    filterFields: ingredientFilterFields,
    mcpListOut: ingredientMcpListOut,
    out: ingredientMcpOut,
    slim: slimIngredient,
    sort: { orderBy: "name" },
    descriptions: {
      list: "Search ingredients by name. Returns id, name, aliases, linked products, and recipe count.",
      get: "Get a single ingredient by ID, including linked products and recipes it appears in.",
      create:
        "Create a new ingredient. Use search_ingredients first to avoid duplicates.",
      update: "Update an ingredient's name or aliases.",
      delete:
        "Soft-delete ingredients by IDs. Fails if an ingredient is used in recipes or linked to products.",
    },
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
        .then((results) => ({
          results,
        })),
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
      const merges = params.merges;
      const dryRun = params.dryRun;
      const results: Array<{
        target: (typeof merges)[number]["target"];
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
          results.push({
            target,
            ok: true,
            summary: result.mergeSummary,
          });
        } catch (error) {
          results.push({
            target,
            ok: false,
            error: formatToolError(error),
          });
        }
      }
      const payload = {
        merged: results.filter((r) => r.ok).length,
        total: results.length,
        results,
      };
      return payload.merged === 0
        ? structuredSuccessWithError(payload, ingredientMergeBatchOut)
        : payload;
    },
  });

  registerMcpTool(server, {
    name: "get_ingredient_raw_lines",
    description:
      "Bulk parser-triage dump: for each ingredient id, the original rawLine of every recipe line currently linked to it.",
    inputSchema: {
      ids: z
        .array(idParam("ingredient"))
        .min(1)
        .describe("Ingredient shortcodes to dump raw lines for"),
    },
    outputSchema: ingredientRawLinesBatchOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const rows = await caller.ingredient.rawLines({ ids: params.ids });
      const byIngredient = groupBy(rows, (r) => r.ingredientId);
      const ingredients = Object.values(byIngredient).map((lines) => {
        const first = lines[0]!;
        return {
          ingredientId: first.ingredientId,
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
        };
      });
      return { count: ingredients.length, ingredients };
    },
  });
}
