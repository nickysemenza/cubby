import type {
  aiLocationIdInput,
  aiUsageRecentInput,
  aiUsageSummaryInput,
  approveDetectedInventoryItemInput,
  categorySuggestionInput,
  enrichmentProposalPrecomputeInput,
  ingredientMergeSuggestionBatchInput,
  locationSuggestionInput,
  locationTypeSuggestionInput,
  parseSearchInput,
  productIdentificationInput,
  usdaFoodSuggestionBatchInput,
  usdaFoodSuggestionInput,
} from "@cubby/schemas/ai";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { z } from "zod";

import { streamProgress } from "~/lib/bulk-progress";
import {
  CATEGORY_DESCRIPTIONS,
  getAnthropicClient,
} from "~/server/clients/anthropic";
import type { Database } from "~/server/db";
import { listRecentAiUsage, summarizeAiUsage } from "~/server/repo/ai-usage";
import { getLocationNames } from "~/server/repo/location/crud";
import { getProductSummaryForAudit } from "~/server/repo/product";
import {
  resolveAllOrThrow,
  resolveLiveShortcodes,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { suggestIngredientMergeBatch } from "~/server/services/ai-enrichment/ingredient-merge";
import { suggestLocationForProduct } from "~/server/services/ai-enrichment/location-suggest";
import {
  approveDetectedInventoryItem,
  backfillLocationDescriptions,
  describeLocation,
  detectInventoryItems,
} from "~/server/services/ai-enrichment/location-vision";
import { precomputeEnrichmentProposals } from "~/server/services/ai-enrichment/proposals";
import {
  suggestUsdaFood,
  suggestUsdaFoodBatch,
} from "~/server/services/ai-enrichment/usda-match";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
export const suggestCategoryWorkflow = (
  db: Database,
  input: z.output<typeof categorySuggestionInput>,
) =>
  getAnthropicClient().suggestCategory(input.productName, input.manufacturer, {
    db,
    feature: "product-category-suggestion",
    operation: "suggestCategory",
    cacheStatus: "none",
  });
export const suggestLocationTypeWorkflow = (
  db: Database,
  input: z.output<typeof locationTypeSuggestionInput>,
) =>
  getAnthropicClient().suggestLocationType(input.locationName, {
    db,
    feature: "location-type-suggestion",
    operation: "suggestLocationType",
    cacheStatus: "none",
  });
export const suggestLocationWorkflow = async (
  db: Database,
  input: z.output<typeof locationSuggestionInput>,
) =>
  suggestLocationForProduct(
    db,
    await resolveOrThrow(db, "product", input.productId),
  );
export const describeLocationWorkflow = async (
  db: Database,
  input: z.output<typeof aiLocationIdInput>,
) =>
  describeLocation(db, await resolveOrThrow(db, "location", input.locationId));
export const detectInventoryItemsWorkflow = async (
  db: Database,
  input: z.output<typeof aiLocationIdInput>,
) =>
  detectInventoryItems(
    db,
    await resolveOrThrow(db, "location", input.locationId),
  );
export const approveDetectedInventoryItemWorkflow = async (
  context: AuthenticatedStartOperationContext,
  input: z.output<typeof approveDetectedInventoryItemInput>,
) =>
  approveDetectedInventoryItem(
    context.db,
    {
      ...input,
      locationId: await resolveOrThrow(
        context.db,
        "location",
        input.locationId,
      ),
    },
    context.actorContext,
  );
export const identifyProductWorkflow = (
  db: Database,
  input: z.output<typeof productIdentificationInput>,
) =>
  getAnthropicClient().identifyProduct(input.imageUrls, {
    db,
    feature: "product-identification",
    operation: "identifyProduct",
    cacheStatus: "none",
  });
export const suggestUsdaFoodWorkflow = (
  context: AuthenticatedStartOperationContext,
  input: z.output<typeof usdaFoodSuggestionInput>,
) => suggestUsdaFood(context.usdaService, context.db, input.ingredientName);
export const suggestUsdaFoodBatchWorkflow = async (
  context: AuthenticatedStartOperationContext,
  input: z.output<typeof usdaFoodSuggestionBatchInput>,
) => {
  const ids = await resolveAllOrThrow(
    context.db,
    "ingredient",
    input.ingredients.map((item) => item.id),
  );
  return suggestUsdaFoodBatch(
    context.usdaService,
    context.db,
    input.ingredients.map((item, index) => ({
      id: ids[index]!,
      name: item.name,
    })),
  );
};
export const suggestIngredientMergeBatchWorkflow = async (
  db: Database,
  input: z.output<typeof ingredientMergeSuggestionBatchInput>,
) => {
  const ids = await resolveAllOrThrow(
    db,
    "ingredient",
    input.ingredients.map((item) => item.id),
  );
  const result = await suggestIngredientMergeBatch(
    db,
    input.ingredients.map((item, index) => ({
      id: ids[index]!,
      shortcode: item.id,
      name: item.name,
    })),
  );
  return result.map(({ source, target, ...suggestion }) => ({
    ...suggestion,
    source: { id: source.shortcode, name: source.name },
    target: target ? { id: target.shortcode, name: target.name } : null,
  }));
};
export const precomputeEnrichmentProposalsWorkflow = async (
  context: AuthenticatedStartOperationContext,
  input: z.output<typeof enrichmentProposalPrecomputeInput>,
) => {
  const resolved = await resolveLiveShortcodes(
    context.db,
    input.items.map((item) => item.id),
    "ingredient",
  );
  const items = input.items.flatMap((item) => {
    const id = resolved.get(item.id);
    return id
      ? [{ ...item, ingredientId: parseEntityId("ingredient", id) }]
      : [];
  });
  return precomputeEnrichmentProposals(context.usdaService, context.db, items);
};
export const backfillLocationDescriptionsWorkflow = (db: Database) =>
  streamProgress(backfillLocationDescriptions(db), (result) => result);
export const parseSearchWorkflow = async (
  db: Database,
  input: z.output<typeof parseSearchInput>,
) =>
  getAnthropicClient().parseSearchQuery(
    input.query,
    await getLocationNames(db),
    {
      db,
      feature: "search-query-parse",
      operation: "parseSearchQuery",
      cacheStatus: "none",
    },
  );
export const auditCategoriesWorkflow = async (db: Database) =>
  getAnthropicClient().auditCategories(
    await getProductSummaryForAudit(db),
    CATEGORY_DESCRIPTIONS,
    {
      db,
      feature: "category-audit",
      operation: "auditCategories",
      cacheStatus: "none",
    },
  );
export const listAiUsageRecentWorkflow = (
  db: Database,
  input: z.output<typeof aiUsageRecentInput>,
) => listRecentAiUsage(db, input.limit);
export const summarizeAiUsageWorkflow = (
  db: Database,
  input: z.output<typeof aiUsageSummaryInput>,
) => summarizeAiUsage(db, input.days);
