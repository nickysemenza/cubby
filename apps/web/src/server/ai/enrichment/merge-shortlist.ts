import type { IngredientId } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";

/**
 * Ingredient-merge shortlist assembly for the AI merge suggester.
 *
 * EPUB imports create near-duplicate ingredients that string matching can't
 * catch (scallion≈green onion, cilantro≈coriander, garbanzo≈chickpea).
 * Instead of an agentic search loop, this merges a lexical name search with a
 * semantic nearest-neighbour search (when embeddings are configured) into one
 * shortlist for the model to pick from.
 */
import { type AiCallOwner } from "~/server/ai/policy/call-owner";
import { INGREDIENT_MERGE_FEATURE } from "~/server/ai/policy/features";
import type { Database } from "~/server/db";
import {
  getIngredientMergeCandidatesByIds,
  searchIngredientsForMerge,
} from "~/server/domains/ingredient/repo/search";
import { findSemanticEntityCandidates } from "~/server/generic/embedding/repo/entity-embedding-search";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import {
  embedQuery,
  optionalAiUnavailable,
  semanticEmbeddingsConfigured,
} from "~/server/generic/embedding/service/semantic/embeddings";
import { productionVectorStore } from "~/server/generic/embedding/service/semantic/vector-store";

export interface MergeShortlistEntry {
  id: IngredientId;
  shortcode: string;
  name: string;
  productCount: number;
}

export interface MergeShortlistPort {
  lexical: typeof searchIngredientsForMerge;
  semantic: (
    db: Database,
    name: string,
    excludeId: IngredientId,
    limit: number,
    owner: AiCallOwner,
  ) => Promise<MergeShortlistEntry[]>;
}

/** The lexical leg remains usable when embeddings are unconfigured. */
async function productionSemanticLeg(
  db: Database,
  name: string,
  excludeId: IngredientId,
  limit: number,
  owner: AiCallOwner,
): Promise<MergeShortlistEntry[]> {
  if (!semanticEmbeddingsConfigured()) return [];
  const embedding = await embedQuery(name, { db, ...owner });
  if (!embedding) return [];

  const scan = await findSemanticEntityCandidates(
    db,
    productionVectorStore,
    embedding,
    {
      entityKinds: ["ingredient"],
      limit,
      config: getSemanticEmbeddingConfig(),
    },
  );
  const ids = scan.candidates
    .map((candidate) => parseEntityId("ingredient", candidate.entityId))
    .filter((id) => id !== excludeId);
  if (ids.length === 0) return [];
  return getIngredientMergeCandidatesByIds(db, ids, excludeId);
}

const productionMergeShortlistPort: MergeShortlistPort = {
  lexical: searchIngredientsForMerge,
  semantic: productionSemanticLeg,
};

/**
 * Lexical-first shortlist for one merge candidate search: both legs run
 * concurrently, results merge lexical-first (ties favor the cheaper, more
 * literal signal), dedupe by id, drop the source itself, and cap at `limit`.
 */
export async function buildMergeShortlist(
  db: Database,
  source: { id: IngredientId; name: string },
  owner: AiCallOwner,
  limit = 20,
  port: MergeShortlistPort = productionMergeShortlistPort,
): Promise<{
  candidates: MergeShortlistEntry[];
  semanticUnavailable?: import("@cubby/schemas/ai").OptionalAiUnavailable;
}> {
  const [lexical, semantic] = await Promise.all([
    port.lexical(db, source.name, source.id, 12),
    port
      .semantic(db, source.name, source.id, 12, owner)
      .catch(optionalAiUnavailable),
  ]);

  const byId = new Map<string, MergeShortlistEntry>();
  for (const entry of [
    ...lexical,
    ...(Array.isArray(semantic) ? semantic : []),
  ]) {
    if (entry.id === source.id) continue;
    if (byId.has(entry.id)) continue;
    byId.set(entry.id, entry);
  }
  return {
    candidates: [...byId.values()].slice(0, limit),
    ...(!Array.isArray(semantic) ? { semanticUnavailable: semantic } : {}),
  };
}

export const ingredientMergeSpec = {
  ...INGREDIENT_MERGE_FEATURE.selection,
  feature: INGREDIENT_MERGE_FEATURE,
};
