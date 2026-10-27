/**
 * Every stored derived value's compute adapter, by the `compute` id its
 * declaration names (ADR 0021). The drain looks adapters up here only.
 */
import type { ProductId, RecipeId } from "@cubby/schemas/identifiers";
import type { RecipeTotals } from "@cubby/schemas/recipe-shared";
import {
  type SearchableEntity,
  searchableEntities,
} from "@cubby/schemas/search";

import { USDAClient } from "~/server/clients/usda";
import { inventoryDerivedComputes } from "~/server/domains/inventory/repo/derived";
import { locationDerivedComputes } from "~/server/domains/location/repo/derived";
import { productDerivedComputes } from "~/server/domains/product/repo/derived";
import { projectDerivedComputes } from "~/server/domains/project/repo/derived";
import { commitRecipeTotals } from "~/server/domains/recipe/repo/totals";
import { prepareRecipeRefresh } from "~/server/domains/run/service/derived-refresh";
import { requestUsdaRelease } from "~/server/domains/usda-release/service/client";
import { qualityDerivedComputes } from "~/server/generic/data-quality/repo/derived";
import {
  type DerivedAdapter,
  type DerivedComputes,
  derivedSink,
} from "~/server/generic/derived/repo/compute";
import { prepareProductConversionCoverage } from "~/server/generic/problems/service/problems.service";
import {
  prepareSearchDocuments,
  publishPreparedSearchDocuments,
} from "~/server/generic/search/repo/search-document";
import {
  enqueueEmbeddingRefs,
  productionEmbeddingRefreshPort,
} from "~/server/workflows/background-tasks/embedding";

/**
 * A record's search document: rebuilt from current sources and, for semantic
 * entities, admitted for embedding in the same publication.
 */
const searchSink = (entity: SearchableEntity) =>
  derivedSink({
    prepare: (db, ids) =>
      prepareSearchDocuments(
        db,
        ids.map((entityId) => ({ entityKind: entity, entityId })),
      ),
    publish: async (tx, ids, prepared) => {
      const keep = new Set(ids);
      const current = {
        entries: prepared.entries.filter((entry) =>
          keep.has(entry.source.entityId),
        ),
        missing: prepared.missing.filter((ref) => keep.has(ref.entityId)),
      };
      await publishPreparedSearchDocuments(tx, current);
      if (productionEmbeddingRefreshPort.configured())
        await enqueueEmbeddingRefs(tx, current);
      return ids;
    },
  });

/** Recipe cost and nutrition totals, prepared with USDA outside publication. */
const recipeTotalsSink = derivedSink({
  prepare: async (db, ids) => {
    const totals = new Map<string, RecipeTotals | null>();
    for (const id of ids)
      // SAFETY: the drain passes ids of `recipe.totals` marks only.
      totals.set(
        id,
        await (await prepareRecipeRefresh(db, id as RecipeId)).compute(),
      );
    return totals;
  },
  publish: async (tx, ids, totals) => {
    const updates = ids.flatMap((id) => {
      const value = totals.get(id);
      // SAFETY: the drain passes ids of `recipe.totals` marks only.
      return value ? [{ id: id as RecipeId, totals: value }] : [];
    });
    return commitRecipeTotals(tx, { updates, freshOnlyIds: [] });
  },
});

const conversionCoverageSink = derivedSink({
  prepare: (db, ids) =>
    prepareProductConversionCoverage(
      db,
      // SAFETY: the drain passes ids of `product.conversionCoverage` marks only.
      ids as ProductId[],
      new USDAClient(requestUsdaRelease()),
    ),
  publish: (tx, ids, prepared) => prepared.publish(tx, ids),
});

const searchComputes: Record<string, DerivedAdapter> = Object.fromEntries(
  searchableEntities.map((entity) => [`search.${entity}`, searchSink(entity)]),
);

export const derivedComputes: DerivedComputes = {
  ...productDerivedComputes,
  ...inventoryDerivedComputes,
  ...locationDerivedComputes,
  ...projectDerivedComputes,
  ...qualityDerivedComputes,
  ...searchComputes,
  "recipe.totals": recipeTotalsSink,
  "product.conversionCoverage": conversionCoverageSink,
};
