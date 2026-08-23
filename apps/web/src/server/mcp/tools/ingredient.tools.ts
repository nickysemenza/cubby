import {
  ingredientFilterFields,
  ingredientMcpListOut,
  ingredientMcpOut,
  ingredientResolvableNamesInput,
  ingredientResolveOrCreateResponseOut,
  ingredientUpdateData,
  mcpIngredientCreateInput,
} from "@cubby/schemas/ingredient";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  declareMergeableEntity,
  registerEntityCrudToolset,
  registerRouterTool,
  slimIngredient,
  WRITE_CLOSED,
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

  declareMergeableEntity(
    server,
    "ingredient",
    'Folds the merged-away ingredients\' names and aliases into the survivor\'s alias list, re-points their recipe lines and their linked products onto it (so the survivor inherits their USDA links and prices), then HARD-deletes them — this is the one merge whose losers leave no tombstone row. Recipes using either side have their totals marked stale in the same transaction and recomputed off the request path. Nothing blocks a merge; a bad merge is unrecoverable, and trigram/AI duplicate suggestions have real false positives ("red wine vinegar" vs "white wine vinegar"), so confirm the pair before calling.',
  );
}
