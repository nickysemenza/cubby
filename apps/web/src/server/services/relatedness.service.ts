import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { RelatednessOut } from "@cubby/schemas/relatedness";
import type { Database } from "~/server/db";
import { getProductsSharingTags } from "~/server/repo/product";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  getActiveSuggestionDismissalKeys,
  suggestionCandidateKey,
} from "~/server/repo/suggestion-dismissal";
import { buildProductRelatednessLedger } from "./relatedness-ledger";
import { findSimilarEntitiesForPair } from "./semantic-search.service";

/**
 * Product's one active relatedness slice. Compatibility tags are intentionally
 * display-only evidence while the stored-vector candidates contribute a score.
 */
export async function getProductRelatedness(
  db: Database,
  sourceId: ProductShortcode,
): Promise<RelatednessOut> {
  const sourceEntityId = await resolveOrThrow(db, "product", sourceId);
  const [semantic, siblings, dismissals] = await Promise.all([
    findSimilarEntitiesForPair(db, {
      pair: "product_to_product",
      sourceId,
      limit: 8,
    }),
    getProductsSharingTags(db, sourceEntityId),
    getActiveSuggestionDismissalKeys(db, {
      sourceEntityType: "product",
      sourceEntityId,
      suggestionKind: "product.related",
    }),
  ]);
  const candidates = [
    ...semantic.results.map(({ entity }) => entity.id),
    ...siblings.map((sibling) => sibling.shortcode),
  ];
  const candidateKeys = new Map(
    await Promise.all(
      candidates.map(
        async (shortcode) =>
          [
            shortcode,
            await suggestionCandidateKey("product.related", [shortcode]),
          ] as const,
      ),
    ),
  );
  const visible = (shortcode: string) =>
    !dismissals.has(candidateKeys.get(shortcode) ?? "");
  return {
    status: semantic.status,
    items: buildProductRelatednessLedger(
      semantic.results.map(({ entity, similarity }) => ({
        id: entity.id,
        title: entity.title,
        similarity,
      })),
      siblings,
      visible,
    ),
  };
}
