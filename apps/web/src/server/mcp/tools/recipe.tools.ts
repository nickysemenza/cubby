import { positiveAmount } from "@cubby/schemas/codec";
import { id as lineId } from "@cubby/schemas/identifiers";
import {
  mcpRecipeCreateFromTextInput,
  scrapeRecipeInput,
} from "@cubby/schemas/import-recipe";
import {
  cookbookSummariesMcpOut,
  mcpRecipeCreateInput,
  mcpRecipeUpdateInput,
  recipeAvailabilityMcpOut,
  recipeCostingExplainMcpOut,
  recipeDetailMcpOut,
  recipeMcpListOut,
  recipeRecomputeMcpOut,
  recipesUsingIngredientOut,
  recipeTagsListOut,
  scrapeRecipeMcpOut,
} from "@cubby/schemas/mcp";
import type { RecipeUsage } from "@cubby/schemas/recipe";
import {
  recipeInstructionInput,
  recipeListFilterFields,
  recipeMcpOut,
} from "@cubby/schemas/recipe";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { groupBy } from "es-toolkit";
import { z } from "zod";
import type { Caller } from "./_shared";
import {
  getCaller,
  idParam,
  READ_ONLY_CLOSED,
  READ_ONLY_OPEN,
  registerEntityCrudToolset,
  registerMcpTool,
  registerRouterTool,
  resolvePublicId,
  resolvePublicIdMap,
  slimRecipe,
  WRITE_CLOSED,
} from "./_shared";

/**
 * `mcpRecipeCreateInput`/`mcpRecipeUpdateInput` carry `sections[].ingredients[]`,
 * a discriminated union of `{type: "ingredient", ingredientId}` /
 * `{type: "recipe", recipeId}` (a sub-recipe reference) — both branded uuids
 * shared with the tRPC router, so this MCP shape is rebuilt locally rather
 * than edited in packages/schemas. `id` here is the line's OWN row id (a
 * declared exception — recipe section/line ids have no shortcode and stay
 * uuid), never a shortcode.
 */
const mcpRecipeIngredientInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ingredient"),
    ingredientId: idParam("ingredient"),
    recipeId: z.null(),
    amounts: z.array(positiveAmount),
    id: lineId.optional(),
    rawLine: z.string().nullish(),
    modifier: z.string().nullish(),
  }),
  z.object({
    type: z.literal("recipe"),
    recipeId: idParam("recipe").describe("Sub-recipe shortcode"),
    ingredientId: z.null(),
    amounts: z.array(positiveAmount),
    id: lineId.optional(),
    rawLine: z.string().nullish(),
    modifier: z.string().nullish(),
  }),
]);

const mcpRecipeSectionInput = z.object({
  name: z.string().min(2).nullable().optional(),
  ingredients: z.array(mcpRecipeIngredientInput).min(1).optional(),
  instructions: z.array(recipeInstructionInput).min(1).optional(),
  id: lineId.optional(),
});

const recipeCreateMcpInput = mcpRecipeCreateInput.extend({
  sections: z
    .array(mcpRecipeSectionInput)
    .describe(
      "Recipe sections, each with ingredients (by ingredient/recipe SHORTCODE) and instructions",
    ),
});

const recipeUpdateMcpInput = mcpRecipeUpdateInput.extend({
  id: idParam("recipe").describe("Recipe shortcode"),
  sections: z
    .array(mcpRecipeSectionInput)
    .optional()
    .describe(
      "Recipe sections, each with ingredients (by ingredient/recipe SHORTCODE) and instructions",
    ),
});

type McpRecipeSection = z.infer<typeof mcpRecipeSectionInput>;

/**
 * `recipeIdOut` (`{id: recipeId}`) is a bare uuid wrapper — `import_recipe`/
 * `create_recipe_from_text` predate the cutover, and `caller.recipe.
 * insertImport`'s own output (`recipeImportIdOut`) carries no shortcode
 * either, so one is resolved via `shortcode.lookupMany` in each handler
 * below rather than edited in packages/schemas.
 */
const recipeShortcodeOut = z.object({ shortcode: idParam("recipe") });

/**
 * `recipesUsingIngredientOut` echoes the seed `ingredientId` (a raw uuid, no
 * shortcode sibling) and each `recipes[]` row's own `id` (which DOES already
 * have a `shortcode` sibling from the previous cutover pass, on
 * `recipeWithUsagesMcpFields`). The seed needs no lookup — the handler
 * already has the shortcode it was called with, before resolving it to a
 * uuid.
 */
const recipesUsingIngredientMcpOut = z.object({
  ingredientShortcode: idParam("ingredient"),
  count: recipesUsingIngredientOut.shape.count,
  recipes: z.array(
    recipesUsingIngredientOut.shape.recipes.element.omit({ id: true }),
  ),
});

/**
 * Resolve every ingredient/recipe shortcode inside a recipe's `sections[]` to
 * its uuid, grouped by entity so each resolves in ONE batched call regardless
 * of how many sections/lines reference it.
 */
async function resolveRecipeSections(
  caller: Caller,
  sections: McpRecipeSection[],
) {
  const ingredientCodes: string[] = [];
  const recipeCodes: string[] = [];
  for (const section of sections) {
    for (const line of section.ingredients ?? []) {
      if (line.type === "ingredient") ingredientCodes.push(line.ingredientId);
      else recipeCodes.push(line.recipeId);
    }
  }
  const [ingredientIds, recipeIds] = await Promise.all([
    resolvePublicIdMap(caller, "ingredient", ingredientCodes),
    resolvePublicIdMap(caller, "recipe", recipeCodes),
  ]);
  return sections.map((section) => ({
    ...section,
    ingredients: section.ingredients?.map((line) =>
      line.type === "ingredient"
        ? { ...line, ingredientId: ingredientIds.get(line.ingredientId)! }
        : { ...line, recipeId: recipeIds.get(line.recipeId)! },
    ),
  }));
}

export function registerRecipeTools(server: McpServer) {
  registerEntityCrudToolset(server, {
    entity: "recipe",
    names: { delete: "delete_recipe" },
    createInput: recipeCreateMcpInput,
    updateShape: {},
    updateInput: recipeUpdateMcpInput,
    filterFields: recipeListFilterFields,
    mcpListOut: recipeMcpListOut,
    out: recipeMcpOut,
    detailOut: recipeDetailMcpOut,
    detailSlim: false,
    slim: slimRecipe,
    sort: { orderBy: "name" },
    descriptions: {
      list: "List recipes by name. Returns id, name, shortcode, yield, servings, tags.",
      get: "Get a recipe by ID, including sections, ingredients, and instructions.",
      create:
        "Create a recipe from structured input (sections with ingredient shortcodes and instructions).",
      update: "Update a recipe's fields. Only provided fields are changed.",
      delete: "Soft-delete recipes by IDs.",
    },
    create: async (caller, params) =>
      caller.recipe.create({
        ...params,
        sections: await resolveRecipeSections(caller, params.sections),
      }),
    resolveUpdateData: async (caller, data) => {
      if (data.sections === undefined) return data;
      return {
        ...data,
        sections: await resolveRecipeSections(
          caller,
          data.sections as McpRecipeSection[],
        ),
      };
    },
  });

  registerRouterTool(server, {
    name: "find_cookable_recipes",
    description:
      "Rank recipes by how well current inventory covers their ingredients.",
    inputSchema: {
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
    outputSchema: recipeAvailabilityMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: async (caller, params) => {
      const { recipes } = await caller.suggestions.getMakeable({
        minCoverage: params.minCoverage,
        limit: params.limit,
      });
      return { recipes };
    },
  });

  registerMcpTool(server, {
    name: "find_recipes_using_ingredient",
    description:
      "Reverse lookup: given an ingredient ID, return every recipe that uses it.",
    inputSchema: { id: idParam("ingredient") },
    outputSchema: recipesUsingIngredientMcpOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const usages = (await caller.ingredient.recipeUsages({
        id: await resolvePublicId(caller, "ingredient", params.id),
      })) as RecipeUsage[];
      const recipes = Object.values(groupBy(usages, (u) => u.recipe.id)).map(
        (rows) => {
          const { id: _id, ...recipe } = slimRecipe(rows[0]!.recipe);
          return {
            ...recipe,
            usages: rows.map((u) => ({
              lineId: u.id,
              sectionName: u.sectionName ?? null,
              amounts: u.amounts,
              rawLine: u.rawLine ?? null,
              modifier: u.modifier ?? null,
            })),
          };
        },
      );
      // `params.id` is the shortcode the tool was called with — the seed's
      // own uuid never enters this handler, so no reverse lookup is needed.
      return { ingredientShortcode: params.id, count: recipes.length, recipes };
    },
  });

  registerRouterTool(server, {
    name: "scrape_recipe",
    description:
      "Parse a recipe from a URL into structured form WITHOUT saving it.",
    inputSchema: { url: scrapeRecipeInput },
    outputSchema: scrapeRecipeMcpOut,
    annotations: READ_ONLY_OPEN,
    call: (caller, params) => caller.recipe.scrape(params.url),
  });

  registerRouterTool(server, {
    name: "import_recipe",
    description:
      "Scrape a recipe from a URL and save it in one step. Returns the new recipe's shortcode.",
    inputSchema: { url: scrapeRecipeInput },
    outputSchema: recipeShortcodeOut,
    annotations: WRITE_CLOSED,
    call: async (caller, params) => {
      const imported = await caller.recipe.scrape(params.url);
      const result = await caller.recipe.insertImport(imported);
      const [ref] = await caller.shortcode.lookupMany({
        refs: [{ entity: "recipe", id: result.id }],
      });
      // Non-null: the row was just inserted in this same request, so the
      // lookup can't miss.
      return { shortcode: ref!.shortcode! };
    },
  });

  registerMcpTool(server, {
    name: "create_recipe_from_text",
    description:
      "Create a recipe from raw text lines WITHOUT pre-resolving ingredient IDs.",
    inputSchema: mcpRecipeCreateFromTextInput.shape,
    outputSchema: recipeShortcodeOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const input = mcpRecipeCreateFromTextInput.parse(params);
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
      const [ref] = await caller.shortcode.lookupMany({
        refs: [{ entity: "recipe", id: result.id }],
      });
      // Non-null: the row was just inserted in this same request, so the
      // lookup can't miss.
      return { shortcode: ref!.shortcode! };
    },
  });

  registerRouterTool(server, {
    name: "list_cookbooks",
    description:
      "List cookbooks (recipe sources) with the number of recipes from each.",
    outputSchema: cookbookSummariesMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: async (caller) => {
      const result = await caller.recipe.listCookbooks();
      return { items: result };
    },
  });

  registerRouterTool(server, {
    name: "get_recipe_tags",
    description: "List all distinct recipe tags in use.",
    outputSchema: recipeTagsListOut,
    annotations: READ_ONLY_CLOSED,
    call: async (caller) => {
      const result = await caller.recipe.getAllTags();
      return { items: result };
    },
  });

  registerRouterTool(server, {
    name: "recompute_recipe_totals",
    description:
      "Recompute every recipe's persisted cost/calorie totals (one-shot backfill / recovery).",
    outputSchema: recipeRecomputeMcpOut,
    annotations: WRITE_CLOSED,
    call: (caller) => caller.recipe.recomputeAll(),
  });

  registerRouterTool(server, {
    name: "explain_recipe_costing",
    description:
      "Explain a recipe's cost/calorie totals with per-ingredient diagnostics.",
    inputSchema: { id: idParam("recipe") },
    outputSchema: recipeCostingExplainMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: async (caller, params) =>
      caller.recipe.explainCosting({
        id: await resolvePublicId(caller, "recipe", params.id),
      }),
  });
}
