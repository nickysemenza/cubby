import type { MergeSummaryOut } from "@cubby/schemas/ingredient";
import {
  mcpIngredientCreateInputShape,
  mcpIngredientSearchInputShape,
  mcpIngredientUpdateInputShape,
} from "@cubby/schemas/ingredient";
import { mcpPaginationParams } from "@cubby/schemas/pagination";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { groupBy } from "es-toolkit";
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
      ...mcpIngredientSearchInputShape,
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
      ...mcpIngredientCreateInputShape,
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
      ...mcpIngredientUpdateInputShape,
    },
    updateHandler("ingredient", slimIngredient),
  );

  server.tool(
    "merge_ingredients",
    "Merge one or more clusters of duplicate ingredients in a single call — the bulk way to clean up a dedup sweep without one tool call per cluster. Each cluster folds its `aliases` into `target`: the target absorbs their names/aliases, and their recipe lines + products (USDA links, prices, unit mappings) re-point onto it; the alias ingredients are then deleted. Clusters merge independently and IN SEQUENCE — one failure is reported in that cluster's result and does NOT abort the rest. A cluster fails LOUD (no silent no-op) if the target/alias is itself in the other side, or any alias id doesn't resolve to a live ingredient. Each successful cluster returns a `summary` ({ aliasesAdded, recipesMoved, productsMoved, deletedIds }). Recompute of the affected recipes is queued off the request path, so even a target used in 100+ recipes merges fast. Set `dryRun` to validate + count every cluster without writing. Pass a single-element array to merge just one cluster.",
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
      dryRun: z
        .boolean()
        .optional()
        .describe(
          "Validate ids and report what each cluster WOULD change, without writing.",
        ),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const merges = params.merges as Array<{
        target: string;
        aliases: string[];
      }>;
      const dryRun = params.dryRun as boolean | undefined;
      // Merge each cluster IN SEQUENCE: a merge re-points its aliases' recipe
      // lines/products onto the target and queues the target's recipes for
      // recompute, so running clusters concurrently could race on a shared
      // product/recipe. Capture per-cluster success/failure — a bad target in one
      // cluster must not sink the batch (partial-result contract).
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
      const merged = results.filter((r) => r.ok).length;
      const payload = { merged, total: results.length, results };
      // Partial success stays a success — the per-cluster `ok` flags carry the
      // detail. But if EVERY cluster failed, flag the envelope `isError` too so a
      // client that only checks the top-level flag still detects total failure.
      return merged === 0
        ? { ...json(payload), isError: true as const }
        : json(payload);
    }),
  );

  server.tool(
    "delete_ingredients",
    "Soft-delete ingredients by IDs. Fails if an ingredient is used in recipes or linked to products.",
    { ids: idsParam("ingredient") },
    deleteHandler("ingredient"),
  );

  server.tool(
    "get_ingredient_raw_lines",
    "Bulk parser-triage dump: for each ingredient id, the original `rawLine` (plus parsed `modifier`/`amounts`) of every recipe line currently linked to it, with the owning recipe. The signal for spotting junk/mis-parsed ingredients — instruction fragments ('Arrange the vegetables'), quantity stubs ('plus 2 tsp salt'), bare modifiers ('medium') — that the importer created as ingredients. Get many ids' source lines in ONE call instead of paging find_recipes_using_ingredient per id. Returns one entry per ingredient with its `lines`.",
    {
      ids: z
        .array(z.string())
        .min(1)
        .describe("Ingredient IDs to dump raw lines for"),
    },
    withErrorHandling(async (params, extra) => {
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
      return json({ count: ingredients.length, ingredients });
    }),
  );
}
