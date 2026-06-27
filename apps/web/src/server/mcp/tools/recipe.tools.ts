import { mcpPaginationParams } from "@cubby/schemas/pagination";
import {
  mcpRecipeCreateInputShape,
  mcpRecipeUpdateInputShape,
} from "@cubby/schemas/recipe";
import type { RecipeUsage } from "@cubby/schemas/recipe-responses";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { groupBy, omitBy } from "es-toolkit";
import { z } from "zod";
import {
  deleteHandler,
  getByIdHandler,
  getCaller,
  idParam,
  idsParam,
  json,
  listHandler,
  respond,
  slimRecipe,
  withErrorHandling,
} from "./_shared";

// Raw-text recipe input: ingredient/instruction lines as plain strings (no
// pre-resolved IDs). The server WASM-parses each ingredient line and
// find-or-creates ingredients — the same pipeline as URL/Notion import. Maps
// onto the `ImportRecipe` carrier consumed by `recipe.insertImport`.
const createRecipeFromTextInputShape = {
  name: z.string().min(1).describe("Recipe name"),
  servings: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Number of servings"),
  yield: z
    .string()
    .optional()
    .describe(
      "Freeform yield, e.g. '2 loaves' or 'Makes 12 pancakes' (parsed server-side)",
    ),
  notes: z.string().optional().describe("Headnote / notes markdown"),
  sections: z
    .array(
      z.object({
        name: z
          .string()
          .optional()
          .describe(
            "Section name, e.g. 'Sauce' (omit for a single unnamed section)",
          ),
        ingredients: z
          .array(z.string())
          .describe(
            "Raw ingredient lines, e.g. '1 cup jasmine rice' — NOT ingredient IDs",
          ),
        instructions: z
          .array(z.string())
          .default([])
          .describe("Instruction step lines, one string per step"),
      }),
    )
    .min(1)
    .describe(
      "Recipe sections; each holds raw ingredient lines and instruction steps",
    ),
};

const createRecipeFromTextInput = z.object(createRecipeFromTextInputShape);

export function registerRecipeTools(server: McpServer) {
  // -------------------------------------------------------------------------
  // Recipe tools (read-only)
  // -------------------------------------------------------------------------

  server.tool(
    "list_recipes",
    "List recipes by name. Returns id, name, shortcode, yield, servings, tags.",
    {
      nameFilter: z
        .string()
        .optional()
        .describe("Filter by recipe name (substring)"),
      ...mcpPaginationParams,
    },
    listHandler("recipe", slimRecipe, {
      orderBy: "name",
      buildFilters: (p) => ({ nameFilter: p.nameFilter }),
    }),
  );

  server.tool(
    "get_recipe",
    "Get a recipe by ID, including sections, ingredients, and instructions.",
    { id: idParam("Recipe") },
    getByIdHandler("recipe"),
  );

  server.tool(
    "find_cookable_recipes",
    "Rank recipes by how well current inventory covers their ingredients — answers 'what can I make right now?'. Each result includes a coverage ratio (0..1) and the list of missing ingredients.",
    {
      minCoverage: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Only return recipes with at least this coverage (0..1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max recipes to return (default 24, max 100)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.suggestions.getMakeable({
        minCoverage: params.minCoverage,
        limit: params.limit,
      });
      return json(result);
    }),
  );

  server.tool(
    "find_recipes_using_ingredient",
    "Reverse lookup: given an ingredient ID, return every recipe that uses it. The efficient answer to 'which recipes call for this ingredient?' — don't enumerate list_recipes. Get the ID from search_ingredients. Each recipe appears once (a recipe using the ingredient in multiple sections gets multiple `usages`); each usage carries `lineId` (the RecipeSectionIngredient id — the stable handle for re-pointing or fixing one line), `rawLine`/`modifier`/`amounts` (parser-triage signal), and `sectionName`. The top-level `ingredientId` echoes the queried ingredient (the current link for every line).",
    { id: idParam("Ingredient") },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      // ingredient.recipeUsages returns one row per RecipeSectionIngredient, so a
      // recipe repeats once per section that uses the ingredient. Collapse to one
      // entry per recipe (slimmed) with its per-section usage contexts. Each usage
      // keeps its RSI `lineId` so a caller can re-point or triage that exact line.
      const usages = (await caller.ingredient.recipeUsages({
        id: params.id,
      })) as RecipeUsage[];
      const recipes = Object.values(groupBy(usages, (u) => u.recipe.id)).map(
        (rows) => ({
          ...slimRecipe(rows[0]!.recipe),
          usages: rows.map((u) => ({
            lineId: u.id,
            sectionName: u.sectionName ?? null,
            amounts: u.amounts,
            rawLine: u.rawLine ?? null,
            modifier: u.modifier ?? null,
          })),
        }),
      );
      return json({ ingredientId: params.id, count: recipes.length, recipes });
    }),
  );

  // -------------------------------------------------------------------------
  // Recipe tools (write)
  // -------------------------------------------------------------------------

  server.tool(
    "scrape_recipe",
    "Parse a recipe from a URL into structured form WITHOUT saving it. Returns the parsed recipe — use import_recipe to also save it.",
    { url: z.string().url().describe("Recipe page URL") },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.recipe.scrape(params.url);
      return json(result);
    }),
  );

  server.tool(
    "import_recipe",
    "Scrape a recipe from a URL and save it in one step. Returns the new recipe's id.",
    { url: z.string().url().describe("Recipe page URL") },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const imported = await caller.recipe.scrape(params.url);
      const result = await caller.recipe.insertImport(imported);
      return json({ id: result.id });
    }),
  );

  server.tool(
    "create_recipe_from_text",
    "Create a recipe from raw text lines WITHOUT pre-resolving ingredient IDs. Pass ingredient and instruction lines as plain strings; the server parses each ingredient line (quantity/unit/name) and find-or-creates ingredients automatically. Mirrors the app's 'from text' / Notion import. Prefer this over resolve_ingredients + create_recipe when building a recipe from a prep sheet or pasted text. Returns the new recipe's id.",
    createRecipeFromTextInputShape,
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const input = createRecipeFromTextInput.parse(params);
      // Build the ImportRecipe carrier. `meta.recipe_yield` is re-parsed and
      // top-level `servings` wins over the yield-derived count (see
      // normalizeImportRecipe); `meta.description` flows into composed notes.
      const importRecipe = {
        meta: {
          title: input.name,
          ...(input.notes ? { description: input.notes } : {}),
          ...(input.yield ? { recipe_yield: input.yield } : {}),
        },
        sections: input.sections.map((s) => ({
          ...(s.name ? { name: s.name } : {}),
          ingredients: s.ingredients,
          instructions: s.instructions,
        })),
        references: [],
        ...(input.servings != null ? { servings: input.servings } : {}),
      };
      const result = await caller.recipe.insertImport(importRecipe);
      return json({ id: result.id });
    }),
  );

  server.tool(
    "create_recipe",
    "Create a recipe from structured input (sections with ingredient IDs and instructions). Use search_ingredients to resolve ingredient IDs first.",
    mcpRecipeCreateInputShape,
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.recipe.create(params);
      return respond(result, slimRecipe);
    }),
  );

  server.tool(
    "update_recipe",
    "Update a recipe's fields. Only provided fields are changed.",
    {
      ...mcpRecipeUpdateInputShape,
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const { id, ...rest } = params;
      const data = omitBy(rest, (v) => v === undefined);
      const result = await caller.recipe.update({ id, data });
      return respond(result, slimRecipe);
    }),
  );

  server.tool(
    "delete_recipe",
    "Soft-delete recipes by IDs.",
    { ids: idsParam("recipe") },
    deleteHandler("recipe"),
  );

  server.tool(
    "list_cookbooks",
    "List cookbooks (recipe sources) with the number of recipes from each.",
    {},
    withErrorHandling(async (_params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.recipe.listCookbooks();
      return json(result);
    }),
  );

  server.tool(
    "get_recipe_tags",
    "List all distinct recipe tags in use.",
    {},
    withErrorHandling(async (_params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.recipe.getAllTags();
      return json(result);
    }),
  );

  server.tool(
    "recompute_recipe_totals",
    "Recompute every recipe's persisted cost/calorie totals (one-shot backfill / recovery, e.g. after the USDA backend was unavailable). Use explain_recipe_costing first to diagnose WHY a total looks wrong.",
    {},
    withErrorHandling(async (_params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.recipe.recomputeAll();
      return json(result);
    }),
  );

  server.tool(
    "explain_recipe_costing",
    "Explain a recipe's cost/calorie totals: persisted state (totals, computed-at, stale?), a fresh compute with per-ingredient diagnostics (usage classification, fired consumption rule, exact per-measure errors, unit-graph conversion paths), named USDA misses, and persisted-vs-computed drift. Read-only. Pair with recompute_recipe_totals to heal.",
    { id: z.string().describe("Recipe ID") },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.recipe.explainCosting({ id: params.id });
      return json(result);
    }),
  );
}
