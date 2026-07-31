import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { anyShortcodeSchema } from "@cubby/schemas/identifiers";
import { similarEntitiesMcpOut } from "@cubby/schemas/mcp";
import {
  globalSearchInputSchema,
  searchResultItemSchema,
  similarEntitiesInputSchema,
  similarEntityPairs,
} from "@cubby/schemas/search";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { uniq } from "es-toolkit";
import { z } from "zod";
import {
  getCaller,
  READ_ONLY_CLOSED,
  registerMcpTool,
  resolvePublicId,
} from "./_shared";

/**
 * `globalSearchMcpOut`/`similarEntitiesMcpOut` publish the router's result
 * verbatim (see `registerRouterTool`'s doc comment) — both carry a raw `id`
 * on every result item alongside the `shortcode` that's already there for
 * exactly this reason (see `searchResultItemSchema`). Rebuilt locally with
 * `id` omitted from every discriminated-union member rather than edited in
 * packages/schemas, per the shortcode-cutover boundary for this pass.
 */
const searchResultItemMcpOut = z.union(
  (searchResultItemSchema.options as z.ZodObject[]).map((option) =>
    option.omit({ id: true }),
  ) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]],
);

function dropId<T extends { id: unknown }>({
  id: _id,
  ...rest
}: T): Omit<T, "id"> {
  return rest;
}

const globalSearchMcpOutLocal = z.object({
  results: z.array(searchResultItemMcpOut),
});

const similarEntitiesMcpOutLocal = z.object({
  source: z.object({
    entityType: similarEntitiesMcpOut.shape.source.shape.entityType,
    // `entityId` (the seed's own uuid) has no shortcode sibling on
    // `searchableEntityRefSchema` — resolved with one extra batched lookup
    // in the handler below rather than edited in packages/schemas.
    entityShortcode: z.string().nullable(),
  }),
  results: z.array(
    z.object({
      similarity: z.number(),
      entity: searchResultItemMcpOut,
    }),
  ),
});

/** Every entity that can be a `find_similar_entities` seed, from the pair map. */
const SIMILAR_SOURCE_ENTITIES = uniq(
  Object.values(similarEntityPairs).map((p) => p.source),
) as [ShortcodeEntity, ...ShortcodeEntity[]];

export function registerSearchTools(server: McpServer) {
  registerMcpTool(server, {
    name: "global_search",
    description:
      "Fuzzy name search across every indexed entity in one call — products, inventory entries, locations, recipes, ingredients, cookbooks, meals, and the household tracker (projects, tasks, expenses). Pass entityType to restrict the search to one indexed type. Ranked hybrid of lexical (exact/substring/trigram) and semantic matching; pass mode: 'lexical' to skip the embedding call for a faster, name-only pass. Each hit returns entityType + shortcode, so this is the way to turn a name into an id before calling get_*/update_* tools. For entity-to-entity matching (which product does this expense refer to?) use find_similar_entities instead.",
    inputSchema: globalSearchInputSchema.shape,
    outputSchema: globalSearchMcpOutLocal,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.search.global({
        query: params.query,
        limit: params.limit,
        mode: params.mode,
        entityType: params.entityType,
      });
      return { results: result.map(dropId) };
    },
  });

  registerMcpTool(server, {
    name: "find_similar_entities",
    description:
      "Find the entities whose stored embedding is closest to one seed entity's, along an allowlisted direction: expense_to_product (which product does this expense line refer to?), product_to_product / ingredient_to_ingredient (duplicate hunting), recipe_to_recipe (related recipes). Pass the pair key plus the seed's id; returns each neighbour with its cosine `similarity`, nearest first, and echoes the resolved `source` ref. " +
      "WARNING — these scores RANK candidates, they do not VERIFY them. Nearest-neighbour always returns something, even when the correct answer is 'no match', and rank does not track correctness: in a real backfill a WRONG match (an M18 Hackzall for 'm18 angle grinder', cosine distance 0.326) scored BETTER than a CORRECT one (a TS 55 Track Saw for 'festool track saw', 0.353) — so a high score is not evidence, and a lower-ranked hit can be the right one. Never auto-apply, auto-link, or bulk-write a result. Read each candidate's name and details, confirm every match with the user, and be willing to conclude that none of them match. " +
      "Returns an empty result set when the seed has no embedding yet or embeddings are not configured — that is 'unknown', not 'nothing is similar'.",
    // `sourceId` is polymorphic — which entity it names is decided by `pair`,
    // so it can't be a single `shortcodeSchema(entity)`. It takes the public
    // code all the same, and the handler pins it to the pair's source type.
    inputSchema: {
      ...similarEntitiesInputSchema.shape,
      sourceId: anyShortcodeSchema(SIMILAR_SOURCE_ENTITIES).describe(
        "Shortcode of the seed entity; its prefix must match the pair's source type (e.g. EXP-4K7M for expense_to_product).",
      ),
    },
    outputSchema: similarEntitiesMcpOutLocal,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const sourceEntity = similarEntityPairs[params.pair].source;
      const result = await caller.search.similar({
        ...params,
        sourceId: await resolvePublicId(caller, sourceEntity, params.sourceId),
      });
      const [sourceCode] = await caller.shortcode.lookupMany({
        refs: [
          { entity: result.source.entityType, id: result.source.entityId },
        ],
      });
      return {
        source: {
          entityType: result.source.entityType,
          entityShortcode: sourceCode?.shortcode ?? null,
        },
        results: result.results.map((r) => ({
          similarity: r.similarity,
          entity: dropId(r.entity),
        })),
      };
    },
  });
}
