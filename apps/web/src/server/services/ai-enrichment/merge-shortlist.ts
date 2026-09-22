import type { ImportRunId, IngredientId } from "@cubby/schemas/identifiers";
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
import type { AiSelectionSpec } from "~/server/ai/selection";
import type { Database } from "~/server/db";
import { findSemanticEntityCandidates } from "~/server/repo/entity-embedding-search";
import {
  getIngredientMergeCandidatesByIds,
  searchIngredientsForMerge,
} from "~/server/repo/ingredient";
import {
  embedQuery,
  semanticEmbeddingsConfigured,
} from "~/server/semantic/embeddings";
import { productionVectorStore } from "~/server/semantic/vector-store";

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
    runId: ImportRunId,
  ) => Promise<MergeShortlistEntry[]>;
}

/** Degrades to `[]` (not an error) when embeddings are unconfigured or the
 * query fails to embed — the lexical leg alone is a fine shortlist. */
async function productionSemanticLeg(
  db: Database,
  name: string,
  excludeId: IngredientId,
  limit: number,
  runId: ImportRunId,
): Promise<MergeShortlistEntry[]> {
  if (!semanticEmbeddingsConfigured()) return [];
  const embedding = await embedQuery(name, { db, runId });
  if (!embedding) return [];

  const candidates = await findSemanticEntityCandidates(
    productionVectorStore,
    embedding,
    { entityTypes: ["ingredient"], limit },
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
  runId: ImportRunId,
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

const MERGE_RULES = `You decide whether a recipe ingredient is the SAME purchasable item as an existing ingredient, so the two can be merged (deduplicated).

Merge ONLY when they are the same thing you would buy — synonyms, alternate names, or spelling/case variants. Examples to merge: scallion = green onion; cilantro = coriander (leaf); garbanzo beans = chickpeas; confectioners' sugar = powdered sugar.

NEVER merge distinct variants a cook treats differently: light vs dark brown sugar; whole vs 2% milk; salted vs unsalted butter; fresh vs dried herbs.

Each candidate is shown as "id [N products]: name". Prefer a target that already has products — the merge inherits them.

Decline when unsure. A wrong merge is destructive, so be conservative.`;

export const ingredientMergeSpec: AiSelectionSpec<MergeShortlistEntry> = {
  feature: INGREDIENT_MERGE_FEATURE,
  rules: MERGE_RULES,
  idOf: (entry) => entry.id,
  renderLine: (entry) =>
    `${entry.id} [${entry.productCount} products]: ${entry.name}`,
  maxCandidates: 20,
};
