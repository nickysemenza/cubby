import {
  ingredientFilterFields,
  ingredientMcpListOut,
  ingredientMcpOut,
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
  mustResolvedId,
  READ_ONLY_CLOSED,
  registerEntityCrudToolset,
  registerMcpTool,
  registerRouterTool,
  resolvePublicIdMap,
  resolvePublicIds,
  slimIngredient,
  structuredSuccessWithError,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
} from "./_shared";

/**
 * `ingredientMergeBatchInput` (target/aliases as branded ingredient uuids) is
 * MCP-only but lives in packages/schemas — this local shape is what the
 * shortcode conversion actually needs, kept beside the tool per the "prefer
 * defining it next to the tool" rule rather than edited in place.
 */
const mergeIngredientsMcpInput = z.object({
  merges: z
    .array(
      z.object({
        target: idParam("ingredient").describe(
          "Shortcode of the ingredient to keep",
        ),
        aliases: z
          .array(idParam("ingredient"))
          .min(1)
          .describe(
            "Shortcodes of duplicate ingredients to fold into the target",
          ),
      }),
    )
    .min(1)
    .describe("One entry per duplicate cluster to merge"),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Validate shortcodes and report what each cluster WOULD change, without writing.",
    ),
});

/**
 * `ingredientRawLinesBatchOut` carries raw `ingredientId`/`recipeId` uuids
 * with no shortcode of its own (`get_ingredient_raw_lines` predates the
 * cutover) — rebuilt locally with both swapped for their shortcodes.
 * `lineId` is a declared exception: a recipe line has no shortcode.
 */
const ingredientRawLineMcpOut =
  ingredientRawLinesBatchOut.shape.ingredients.element.shape.lines.element
    .omit({ recipeId: true })
    .extend({
      // Nullable: resolved via `shortcode.lookupMany`, which returns `null` on
      // a miss rather than throwing (a display enrichment, not a write
      // precondition) — unlike `ingredientShortcode` below, which comes
      // straight from the already-validated input codes.
      recipeShortcode: idParam("recipe").nullable(),
    });

const ingredientRawLinesBatchMcpOut = ingredientRawLinesBatchOut
  .omit({ ingredients: true })
  .extend({
    ingredients: z.array(
      ingredientRawLinesBatchOut.shape.ingredients.element
        .omit({ ingredientId: true, lines: true })
        .extend({
          ingredientShortcode: idParam("ingredient"),
          lines: z.array(ingredientRawLineMcpOut),
        }),
    ),
  });

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
        .then((results: unknown) => ({
          results,
        })),
  });

  registerMcpTool(server, {
    name: "merge_ingredients",
    description:
      "Merge one or more clusters of duplicate ingredients in a single call.",
    inputSchema: mergeIngredientsMcpInput.shape,
    outputSchema: ingredientMergeBatchOut,
    annotations: WRITE_DESTRUCTIVE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const merges = params.merges as Array<{
        target: string;
        aliases: string[];
      }>;
      const dryRun = params.dryRun as boolean | undefined;
      // Every code across every cluster resolves in ONE batched call, since
      // they're all the same entity (ingredient) and a code may recur.
      const idByCode = await resolvePublicIdMap(
        caller,
        "ingredient",
        merges.flatMap((m) => [m.target, ...m.aliases]),
      );
      const results: Array<{
        target: string;
        ok: boolean;
        summary?: MergeSummaryOut;
        error?: string;
      }> = [];
      for (const { target, aliases } of merges) {
        // outputSchema's `target` is a branded ingredientId (uuid), so the
        // resolved id — not the shortcode the caller passed — is what's echoed.
        const targetId = mustResolvedId(idByCode, "ingredient", target);
        const aliasIds = aliases.map((a) =>
          mustResolvedId(idByCode, "ingredient", a),
        );
        try {
          const result = await caller.ingredient.merge({
            target: targetId,
            aliases: aliasIds,
            dryRun,
          });
          results.push({
            target: targetId,
            ok: true,
            summary: result.mergeSummary,
          });
        } catch (error) {
          results.push({
            target: targetId,
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
    outputSchema: ingredientRawLinesBatchMcpOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const ids = await resolvePublicIds(caller, "ingredient", params.ids);
      // `ids` is `resolvePublicIds`' 1:1 mapping of `params.ids` (the
      // shortcodes already in hand) — no reverse lookup needed for the
      // ingredient side, only for the recipes discovered via the join below.
      const shortcodeByIngredientId = new Map(
        // Non-null: `resolvePublicIds` returns exactly one id per input code,
        // same order (see its own doc comment), so `ids` and `params.ids`
        // are always the same length.
        ids.map((id, i) => [id, params.ids[i]!]),
      );
      const rows = (await caller.ingredient.rawLines({
        ids,
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
      const recipeIds = [...new Set(rows.map((r) => r.recipeId))];
      const resolvedRecipes = recipeIds.length
        ? await caller.shortcode.lookupMany({
            refs: recipeIds.map((id) => ({ entity: "recipe" as const, id })),
          })
        : [];
      const recipeShortcodeById = new Map(
        resolvedRecipes.map((r) => [r.id, r.shortcode]),
      );
      const byIngredient = groupBy(rows, (r) => r.ingredientId);
      const ingredients = Object.entries(byIngredient).map(
        ([ingredientId, lines]) => ({
          // Non-null: `ingredientId` here is always one of the ids we just
          // resolved from `params.ids` above, so the zip always hits.
          ingredientShortcode: shortcodeByIngredientId.get(ingredientId)!,
          lineCount: lines.length,
          lines: lines.map((l) => ({
            lineId: l.lineId,
            rawLine: l.rawLine,
            modifier: l.modifier,
            amounts: l.amounts,
            recipeShortcode: recipeShortcodeById.get(l.recipeId) ?? null,
            recipeName: l.recipeName,
            sectionName: l.sectionName,
          })),
        }),
      );
      return { count: ingredients.length, ingredients };
    },
  });
}
