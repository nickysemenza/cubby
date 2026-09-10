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
import { bindWorkflow, workflow } from "~/server/workflow-runtime";
import { findSimilarEntitiesWorkflow } from "~/server/workflows/semantic-similarity.server";

import { buildProductRelatednessLedger } from "./relatedness-ledger";

export interface RelatednessDependencies {
  resolveSourceId: (
    db: Database,
    entity: "product",
    sourceId: ProductShortcode,
  ) => Promise<ProductId>;
  findSimilarEntities: (
    db: Database,
    input: Parameters<typeof findSimilarEntitiesWorkflow>[1],
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

export const productionRelatednessDependencies: RelatednessDependencies = {
  resolveSourceId: resolveOrThrow,
  findSimilarEntities: findSimilarEntitiesWorkflow,
  getProductsSharingTags,
  getProductsByShortcodes,
  getActiveDismissalKeys: getActiveSuggestionDismissalKeys,
  makeCandidateKey: suggestionCandidateKey,
};

/**
 * Product's one active relatedness slice. Compatibility tags are intentionally
 * display-only evidence while the stored-vector candidates contribute a score.
 */
type RelatednessContext = {
  db: Database;
  dependencies: RelatednessDependencies;
};

export const productRelatednessWorkflowDefinition = workflow<
  RelatednessContext,
  ProductShortcode
>("relatedness.product")
  .call("signals", async () => {
    const signals = entityManifest.product.relatednessSignals ?? [];
    const semantic = signals.find((signal) => signal.kind === "semantic");
    const tag = signals.find(
      (signal) =>
        signal.kind === "scalarOverlap" && signal.column === "Product.tags",
    );
    if (!semantic || !tag)
      throw new Error(
        "Product relatedness signals are not declared in the manifest",
      );
    return { semantic, tag };
  })
  .call("source", ({ context }, { input }) =>
    context.dependencies.resolveSourceId(context.db, "product", input),
  )
  .parallel("evidence", 3, {
    semantic: ({ context }, { input, signals }) =>
      context.dependencies.findSimilarEntities(context.db, {
        pair: "product_to_product",
        sourceId: input,
        limit: signals.semantic.limit,
      }),
    siblings: ({ context }, { source }) =>
      context.dependencies.getProductsSharingTags(context.db, source),
    dismissals: ({ context }, { source }) =>
      context.dependencies.getActiveDismissalKeys(context.db, {
        sourceEntityType: "product",
        sourceEntityId: source,
        suggestionKind: "product.related",
      }),
  })
  .map("candidateKeys", {
    items: ({ evidence }) => [
      ...evidence.semantic.results.map(({ entity }) => entity.id),
      ...evidence.siblings.map((sibling) => sibling.shortcode),
    ],
    concurrency: 8,
    run: async ({ context }, { item: shortcode }) =>
      [
        shortcode,
        await context.dependencies.makeCandidateKey("product.related", [
          shortcode,
        ]),
      ] as const,
  })
  .output(({ signals, evidence, candidateKeys }): RelatednessOut => {
    const keys = new Map(candidateKeys);
    return {
      status: evidence.semantic.status,
      items: buildProductRelatednessLedger(
        evidence.semantic.results.map(({ entity, similarity }) => ({
          id: entity.id,
          title: entity.title,
          similarity,
        })),
        evidence.siblings,
        (shortcode) => !evidence.dismissals.has(keys.get(shortcode) ?? ""),
        {
          semantic: {
            label: signals.semantic.label,
            weight: signals.semantic.weight,
          },
          tag: { label: signals.tag.label },
        },
      ),
    };
  });

export const getProductRelatedness = bindWorkflow(
  productRelatednessWorkflowDefinition,
  (
    db: Database,
    sourceId: ProductShortcode,
    dependencies: RelatednessDependencies = productionRelatednessDependencies,
  ) => ({
    context: { db, dependencies },
    input: sourceId,
  }),
);

/**
 * Tags are proposed only from current semantic neighbours. They remain out of
 * relatedness scoring, so the ground-truth label cannot vote for itself.
 */
export const productTagPropagationWorkflowDefinition = workflow<
  RelatednessContext,
  ProductShortcode
>("recommendations.tagPropagation")
  .call("signal", async () => {
    const signal = (entityManifest.product.relatednessSignals ?? []).find(
      (signal) => signal.kind === "semantic",
    );
    if (!signal)
      throw new Error("Product semantic relatedness signal is not declared");
    return signal;
  })
  .parallel("source", 2, {
    id: ({ context }, { input }) =>
      context.dependencies.resolveSourceId(context.db, "product", input),
    semantic: ({ context }, { input, signal }) =>
      context.dependencies.findSimilarEntities(context.db, {
        pair: "product_to_product",
        sourceId: input,
        limit: signal.limit,
      }),
  })
  .parallel("evidence", 2, {
    rows: ({ context }, { input, source }) =>
      context.dependencies.getProductsByShortcodes(context.db, [
        input,
        ...source.semantic.results.map((result) => result.entity.id),
      ]),
    dismissals: ({ context }, { source }) =>
      context.dependencies.getActiveDismissalKeys(context.db, {
        sourceEntityType: "product",
        sourceEntityId: source.id,
        suggestionKind: "product.tag-propagation",
      }),
  })
  .branch("proposals", {
    when: async (_, { source }) => source.semantic.status === "ready",
    whenTrue: (branch) =>
      branch
        .call("votes", async (_, { input }) => {
          const currentTags =
            input.evidence.rows.find((row) => row.id === input.input)?.tags ??
            [];
          const sourceTags = new Set(currentTags);
          const votes = new Map<string, number>();
          for (const candidate of input.evidence.rows) {
            if (candidate.id === input.input) continue;
            for (const tag of new Set(candidate.tags)) {
              if (sourceTags.has(tag) || isCollectionTag(tag)) continue;
              votes.set(tag, (votes.get(tag) ?? 0) + 1);
            }
          }
          return [...votes]
            .filter(([, count]) => count >= 3)
            .map(([tag, supportingProductCount]) => ({
              tag,
              supportingProductCount,
            }))
            .sort(
              (a, b) =>
                b.supportingProductCount - a.supportingProductCount ||
                a.tag.localeCompare(b.tag),
            );
        })
        .map("candidates", {
          items: ({ votes }) => votes,
          concurrency: 8,
          run: async ({ context }, { item }) => ({
            proposal: item,
            key: await context.dependencies.makeCandidateKey(
              "product.tag-propagation",
              [item.tag],
            ),
          }),
        })
        .output(({ input, candidates }) =>
          candidates
            .filter(
              (candidate) => !input.evidence.dismissals.has(candidate.key),
            )
            .map((candidate) => candidate.proposal),
        ),
    whenFalse: (branch) =>
      branch.output((): TagPropagationRecommendationOut["proposals"] => []),
  })
  .output(
    ({
      input,
      source,
      evidence,
      proposals,
    }): TagPropagationRecommendationOut => ({
      status: source.semantic.status,
      currentTags: evidence.rows.find((row) => row.id === input)?.tags ?? [],
      proposals,
    }),
  );

export const getProductTagPropagation = bindWorkflow(
  productTagPropagationWorkflowDefinition,
  (
    db: Database,
    sourceId: ProductShortcode,
    dependencies: RelatednessDependencies = productionRelatednessDependencies,
  ) => ({
    context: { db, dependencies },
    input: sourceId,
  }),
);
