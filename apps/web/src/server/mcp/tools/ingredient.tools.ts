import {
  ingredientBase,
  ingredientFiltersSchema,
} from "@cubby/schemas/ingredient";
import { mcpPaginationParams } from "@cubby/schemas/pagination";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
    "Merge duplicate ingredients into one. Aliases are absorbed into the target, and their recipes/products are re-pointed to it.",
    {
      target: idParam("Ingredient").describe("ID of the ingredient to keep"),
      aliases: z
        .array(idParam("Ingredient"))
        .min(1)
        .describe("IDs of duplicate ingredients to merge into the target"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.ingredient.merge({
        target: params.target,
        aliases: params.aliases,
      });
      return respond(result, slimIngredient);
    }),
  );

  server.tool(
    "delete_ingredients",
    "Soft-delete ingredients by IDs. Fails if an ingredient is used in recipes or linked to products.",
    { ids: idsParam("ingredient") },
    deleteHandler("ingredient"),
  );
}
