/**
 * Every stored derived value's compute adapter, by the `compute` id its
 * declaration names (ADR 0021). The drain looks adapters up here only.
 */
import { parseEntityId, type ProductId } from "@cubby/schemas/identifiers";
import {
  type SearchableEntity,
  searchableEntities,
} from "@cubby/schemas/search";

import { USDAClient } from "~/server/clients/usda";
import { emailDerivedComputes } from "~/server/domains/email/repo/derived";
import { expenseDerivedComputes } from "~/server/domains/expense/repo/derived";
import { inventoryDerivedComputes } from "~/server/domains/inventory/repo/derived";
import { locationDerivedComputes } from "~/server/domains/location/repo/derived";
import { productDerivedComputes } from "~/server/domains/product/repo/derived";
import {
  computeProductReadFacts,
  productFoodCompute,
} from "~/server/domains/product/repo/read-facts";
import { projectDerivedComputes } from "~/server/domains/project/repo/derived";
import { RecipeCostingService } from "~/server/domains/recipe/repo/recipe-costing";
import { commitRecipeTotals } from "~/server/domains/recipe/repo/totals";
import { shipmentDerivedComputes } from "~/server/domains/shipment/repo/event-summary";
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
    // Per-record preparation repeats the same closure hundreds of times and
    // can outlive the page's lease before any work is published.
    const service = new RecipeCostingService(db, {
      findFoodsBatch: (lookups) =>
        new USDAClient(requestUsdaRelease()).findFoodsBatch(lookups),
    });
    const totals: Awaited<ReturnType<typeof service.computeStoredTotals>> =
      new Map();
    // Bound the ingredient graph retained at once; a page can contain 500 marks.
    for (let start = 0; start < ids.length; start += 20)
      for (const [id, value] of await service.computeStoredTotals(
        ids.slice(start, start + 20).map((id) => parseEntityId("recipe", id)),
      ))
        totals.set(id, value);
    return totals;
  },
  publish: async (tx, ids, totals) => {
    const updates = ids.flatMap((id) => {
      const value = totals.get(id);
      return value ? [{ id: parseEntityId("recipe", id), totals: value }] : [];
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
  "product.readFacts": computeProductReadFacts,
  "product.food": (db, ids) =>
    productFoodCompute({
      findFoodsBatch: (lookups) =>
        new USDAClient(requestUsdaRelease()).findFoodsBatch(lookups),
    })(db, ids),
  ...inventoryDerivedComputes,
  ...expenseDerivedComputes,
  ...emailDerivedComputes,
  ...locationDerivedComputes,
  ...projectDerivedComputes,
  ...shipmentDerivedComputes,
  ...qualityDerivedComputes,
  ...searchComputes,
  "recipe.totals": recipeTotalsSink,
  "product.conversionCoverage": conversionCoverageSink,
};
