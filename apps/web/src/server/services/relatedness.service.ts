import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { RelatednessOut } from "@cubby/schemas/relatedness";
import type { Database } from "~/server/db";
import { getProductsSharingTags } from "~/server/repo/product";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  getActiveSuggestionDismissalKeys,
  suggestionCandidateKey,
} from "~/server/repo/suggestion-dismissal";
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
    items: semantic.results
      .filter(({ entity }) => visible(entity.id))
      .map(({ entity, similarity }) => ({
        entity: "product" as const,
        shortcode: entity.id,
        title: entity.title,
        score: similarity,
        evidence: [
          { signal: "Similar meaning", detail: null, weight: similarity },
        ],
      })),
    groups: [
      {
        label: "Compatibility tags",
        items: siblings
          .filter((sibling) => visible(sibling.shortcode))
          .map((sibling) => ({
            entity: "product" as const,
            shortcode: sibling.shortcode,
            title: sibling.name,
            score: 0,
            evidence: [
              {
                signal: "Shared tag",
                detail: sibling.tags.join(", "),
                weight: 0,
              },
            ],
          })),
      },
    ].filter((group) => group.items.length > 0),
  };
}
