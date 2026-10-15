import type { RunId, IngredientId } from "@cubby/schemas/identifiers";
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
import { INGREDIENT_MERGE_FEATURE } from "~/server/ai/features";
import type { Database } from "~/server/db";
import {
  getIngredientMergeCandidatesByIds,
  searchIngredientsForMerge,
} from "~/server/domains/ingredient/repo/search";
import { findSemanticEntityCandidates } from "~/server/generic/embedding/repo/entity-embedding-search";
import {
  embedQuery,
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
    runId: RunId,
  ) => Promise<MergeShortlistEntry[]>;
}

/** Degrades to `[]` (not an error) when embeddings are unconfigured or the
 * query fails to embed — the lexical leg alone is a fine shortlist. */
async function productionSemanticLeg(
  db: Database,
  name: string,
  excludeId: IngredientId,
  limit: number,
  runId: RunId,
): Promise<MergeShortlistEntry[]> {
  if (!semanticEmbeddingsConfigured()) return [];
  const embedding = await embedQuery(name, { db, runId });
  if (!embedding) return [];

  const candidates = await findSemanticEntityCandidates(
    productionVectorStore,
    embedding,
    { entityKinds: ["ingredient"], limit },
  );
  const ids = candidates
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
  runId: RunId,
  limit = 20,
  port: MergeShortlistPort = productionMergeShortlistPort,
): Promise<MergeShortlistEntry[]> {
  const [lexical, semantic] = await Promise.all([
    port.lexical(db, source.name, source.id, 12),
    port.semantic(db, source.name, source.id, 12, runId),
  ]);

  const byId = new Map<string, MergeShortlistEntry>();
  for (const entry of [...lexical, ...semantic]) {
    if (entry.id === source.id) continue;
    if (byId.has(entry.id)) continue;
    byId.set(entry.id, entry);
  }
  return [...byId.values()].slice(0, limit);
}

export const ingredientMergeSpec = {
  ...INGREDIENT_MERGE_FEATURE.selection,
  feature: INGREDIENT_MERGE_FEATURE,
};
