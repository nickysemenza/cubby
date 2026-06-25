import {
  ingredientBase,
  ingredientFiltersSchema,
} from "@cubby/schemas/ingredient";
import { mcpPaginationParams } from "@cubby/schemas/pagination";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  deleteHandler,
  formatToolError,
  getByIdHandler,
  getCaller,
  idParam,
  idsParam,
  json,
  listHandler,
  respond,
  slimIngredient,
  updateHandler,
  withErrorHandling,
} from "./_shared";

export function registerIngredientTools(server: McpServer) {
  server.tool(
    "search_ingredients",
    "Search ingredients by name. Returns id, name, aliases, linked products, and recipe count.",
    {
      // Field names match the router filter exactly — reuse its shape + docs.
      ...ingredientFiltersSchema.shape,
      ...mcpPaginationParams,
    },
    listHandler("ingredient", slimIngredient, {
      orderBy: "name",
      buildFilters: (p) => ({
        nameFilter: p.nameFilter,
        missingProductsOnly: p.missingProductsOnly,
      }),
    }),
  );

  server.tool(
    "get_ingredient",
    "Get a single ingredient by ID, including linked products and recipes it appears in.",
    { id: idParam("Ingredient") },
    getByIdHandler("ingredient", slimIngredient),
  );

  server.tool(
    "create_ingredient",
    "Create a new ingredient. Use search_ingredients first to avoid duplicates.",
    {
      name: ingredientBase.shape.name.describe("Ingredient name"),
      aliases: ingredientBase.shape.aliases
        .optional()
        .describe("Alternate names for this ingredient"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.ingredient.create({
        name: params.name,
        aliases: params.aliases ?? [],
      });
      return respond(result, slimIngredient);
    }),
  );

  server.tool(
    "resolve_ingredients",
    "Batch-resolve a list of ingredient names to IDs in one call: each name is matched to an existing ingredient (case-insensitive, including aliases) or created if missing. Returns one entry per name with `matched`/`created` flags and the resolved id. Use this instead of calling search_ingredients then create_ingredient one name at a time.",
    {
      names: z
        .array(z.string().min(1))
        .describe(
          "Ingredient names to resolve or create, e.g. ['jasmine rice', 'scallion', 'soy sauce']",
        ),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.ingredient.resolveOrCreate({
        names: params.names,
      });
      return json(result);
    }),
  );

  server.tool(
    "update_ingredient",
    "Update an ingredient's name or aliases.",
    {
      id: idParam("Ingredient"),
      name: ingredientBase.shape.name.optional().describe("New name"),
      aliases: ingredientBase.shape.aliases
        .optional()
        .describe("New aliases (replaces)"),
    },
    updateHandler("ingredient", slimIngredient),
  );

  server.tool(
    "merge_ingredients",
    "Merge one or more clusters of duplicate ingredients in a single call — the bulk way to clean up a dedup sweep without one tool call per cluster. Each cluster folds its `aliases` into `target`: the target absorbs their names/aliases, and their recipe lines + products (USDA links, prices, unit mappings) re-point onto it; the alias ingredients are then deleted. Clusters merge independently and IN SEQUENCE — one failure (e.g. a missing target) is reported in that cluster's result and does NOT abort the rest. Pass a single-element array to merge just one cluster.",
    {
      merges: z
        .array(
          z.object({
            target: idParam("Ingredient").describe(
              "ID of the ingredient to keep",
            ),
            aliases: z
              .array(idParam("Ingredient"))
              .min(1)
              .describe("IDs of duplicate ingredients to fold into the target"),
          }),
        )
        .min(1)
        .describe("One entry per duplicate cluster to merge"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const merges = params.merges as Array<{
        target: string;
        aliases: string[];
      }>;
      // Merge each cluster IN SEQUENCE: a merge re-points its aliases' recipe
      // lines/products onto the target and recomputes the target's recipes, so
      // running clusters concurrently could race on a shared product/recipe.
      // Capture per-cluster success/failure — a bad target in one cluster must
      // not sink the batch (partial-result contract).
      const results: Array<{
        target: string;
        ok: boolean;
        mergedAliasCount?: number;
        recipesRecomputed?: number;
        error?: string;
      }> = [];
      for (const { target, aliases } of merges) {
        try {
          const result = await caller.ingredient.merge({ target, aliases });
          results.push({
            target,
            ok: true,
            mergedAliasCount: aliases.length,
            recipesRecomputed: result.sideEffects.recipesRecomputed,
          });
        } catch (error) {
          results.push({ target, ok: false, error: formatToolError(error) });
        }
      }
      return json({
        merged: results.filter((r) => r.ok).length,
        total: results.length,
        results,
      });
    }),
  );

  server.tool(
    "delete_ingredients",
    "Soft-delete ingredients by IDs. Fails if an ingredient is used in recipes or linked to products.",
    { ids: idsParam("ingredient") },
    deleteHandler("ingredient"),
  );
}
