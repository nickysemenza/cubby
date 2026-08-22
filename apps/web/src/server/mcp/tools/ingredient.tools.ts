import {
  type IngredientMergeBatchOut,
  ingredientFilterFields,
  ingredientMcpListOut,
  ingredientMcpOut,
  ingredientMergeBatchInput,
  ingredientMergeBatchOut,
  ingredientResolvableNamesInput,
  ingredientResolveOrCreateResponseOut,
  ingredientUpdateData,
  mcpIngredientCreateInput,
} from "@cubby/schemas/ingredient";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  describeToolError,
  formatToolError,
  getCaller,
  registerEntityCrudToolset,
  registerMcpTool,
  registerRouterTool,
  slimIngredient,
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
      const results: IngredientMergeBatchOut["results"] = [];
      for (const [index, { target, aliases }] of merges.entries()) {
        try {
          const result = await caller.ingredient.merge({
            target,
            aliases,
            dryRun,
          });
          results.push({
            index,
            status: "succeeded",
            target,
            summary: result.mergeSummary,
          });
        } catch (error) {
          // `error` keeps the rendered sentence a human reads; `code`/`reason`
          // carry the same failure in a form a caller can branch on — the same
          // split `registerBatchTool` makes for every other batch tool.
          const { code, reason } = describeToolError(error);
          results.push({
            index,
            status: "failed",
            target,
            error: formatToolError(error),
            ...(code ? { code } : {}),
            ...(reason ? { reason } : {}),
          });
        }
      }
      const succeeded = results.filter((r) => r.status === "succeeded").length;
      // A wholly-failed batch is still `isError: false` — see the doctrine on
      // `registerBatchTool` in `_shared.ts`. The per-item errors are the
      // payload; flagging the envelope would hide them behind a bare string.
      return {
        summary: {
          requested: results.length,
          succeeded,
          failed: results.length - succeeded,
        },
        results,
      };
    },
  });
}
