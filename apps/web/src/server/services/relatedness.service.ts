import { entityManifest } from "@cubby/schemas/entity-manifest";
import type { ProductId, ProductShortcode } from "@cubby/schemas/identifiers";
import type { TagPropagationRecommendationOut } from "@cubby/schemas/recommendations";
import type { RelatednessOut } from "@cubby/schemas/relatedness";
import type { SimilarEntitiesOut } from "@cubby/schemas/search";
import { isCollectionTag } from "@cubby/shared/collection-tag";

import type { Database } from "~/server/db";
import {
  getProductsByShortcodes,
  getProductsSharingTags,
} from "~/server/repo/product";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  getActiveSuggestionDismissalKeys,
  suggestionCandidateKey,
} from "~/server/repo/suggestion-dismissal";

import { buildProductRelatednessLedger } from "./relatedness-ledger";
import { findSimilarEntitiesForPair } from "./semantic-search.service";

export interface RelatednessDependencies {
  resolveSourceId: (
    db: Database,
    entity: "product",
    sourceId: ProductShortcode,
  ) => Promise<ProductId>;
  findSimilarEntities: (
    db: Database,
    input: Parameters<typeof findSimilarEntitiesForPair>[1],
  ) => Promise<SimilarEntitiesOut>;
  getProductsSharingTags: (
    db: Database,
    entityId: ProductId,
  ) => Promise<Array<{ shortcode: string; name: string; tags: string[] }>>;
  getProductsByShortcodes: (
    db: Database,
    shortcodes: string[],
  ) => Promise<Array<{ id: string; tags: string[] }>>;
  getActiveDismissalKeys: (
    db: Database,
    input: Parameters<typeof getActiveSuggestionDismissalKeys>[1],
  ) => Promise<Set<string>>;
  makeCandidateKey: typeof suggestionCandidateKey;
}

const productionDependencies: RelatednessDependencies = {
  resolveSourceId: resolveOrThrow,
  findSimilarEntities: findSimilarEntitiesForPair,
  getProductsSharingTags,
  getProductsByShortcodes,
  getActiveDismissalKeys: getActiveSuggestionDismissalKeys,
  makeCandidateKey: suggestionCandidateKey,
};

/**
 * Product's one active relatedness slice. Compatibility tags are intentionally
 * display-only evidence while the stored-vector candidates contribute a score.
 */
export async function getProductRelatedness(
  db: Database,
  sourceId: ProductShortcode,
  dependencies: RelatednessDependencies = productionDependencies,
): Promise<RelatednessOut> {
  const signals = entityManifest.product.relatednessSignals ?? [];
  const semanticSignal = signals.find((signal) => signal.kind === "semantic");
  const tagSignal = signals.find(
    (signal) =>
      signal.kind === "scalarOverlap" && signal.column === "Product.tags",
  );
  if (!semanticSignal || !tagSignal) {
    throw new Error(
      "Product relatedness signals are not declared in the manifest",
    );
  }
  const sourceEntityId = await dependencies.resolveSourceId(
    db,
    "product",
    sourceId,
  );
  const [semantic, siblings, dismissals] = await Promise.all([
    dependencies.findSimilarEntities(db, {
      pair: "product_to_product",
      sourceId,
      limit: semanticSignal.limit,
    }),
    dependencies.getProductsSharingTags(db, sourceEntityId),
    dependencies.getActiveDismissalKeys(db, {
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
            await dependencies.makeCandidateKey("product.related", [shortcode]),
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
      {
        semantic: {
          label: semanticSignal.label,
          weight: semanticSignal.weight,
        },
        tag: { label: tagSignal.label },
      },
    ),
  };
}

/**
 * Tags are proposed only from current semantic neighbours. They remain out of
 * relatedness scoring, so the ground-truth label cannot vote for itself.
 */
export async function getProductTagPropagation(
  db: Database,
  sourceId: ProductShortcode,
  dependencies: RelatednessDependencies = productionDependencies,
): Promise<TagPropagationRecommendationOut> {
  const semanticSignal = (entityManifest.product.relatednessSignals ?? []).find(
    (signal) => signal.kind === "semantic",
  );
  if (!semanticSignal) {
    throw new Error("Product semantic relatedness signal is not declared");
  }
  const [sourceEntityId, semantic] = await Promise.all([
    dependencies.resolveSourceId(db, "product", sourceId),
    dependencies.findSimilarEntities(db, {
      pair: "product_to_product",
      sourceId,
      limit: semanticSignal.limit,
    }),
  ]);
  const [rows, dismissals] = await Promise.all([
    dependencies.getProductsByShortcodes(db, [
      sourceId,
      ...semantic.results.map((result) => result.entity.id),
    ]),
    dependencies.getActiveDismissalKeys(db, {
      sourceEntityType: "product",
      sourceEntityId,
      suggestionKind: "product.tag-propagation",
    }),
  ]);
  const source = rows.find((row) => row.id === sourceId);
  const currentTags = source?.tags ?? [];
  if (semantic.status !== "ready") {
    return { status: semantic.status, currentTags, proposals: [] };
  }

  const sourceTags = new Set(currentTags);
  const votes = new Map<string, number>();
  for (const candidate of rows) {
    if (candidate.id === sourceId) continue;
    for (const tag of new Set(candidate.tags)) {
      if (sourceTags.has(tag) || isCollectionTag(tag)) continue;
      votes.set(tag, (votes.get(tag) ?? 0) + 1);
    }
  }
  const proposals = [...votes]
    .filter(([, supportingProductCount]) => supportingProductCount >= 3)
    .map(([tag, supportingProductCount]) => ({ tag, supportingProductCount }))
    .sort(
      (a, b) =>
        b.supportingProductCount - a.supportingProductCount ||
        a.tag.localeCompare(b.tag),
    );
  const keys = new Map(
    await Promise.all(
      proposals.map(
        async ({ tag }) =>
          [
            tag,
            await dependencies.makeCandidateKey("product.tag-propagation", [
              tag,
            ]),
          ] as const,
      ),
    ),
  );
  return {
    status: semantic.status,
    currentTags,
    proposals: proposals.filter(
      (proposal) => !dismissals.has(keys.get(proposal.tag) ?? ""),
    ),
  };
}
