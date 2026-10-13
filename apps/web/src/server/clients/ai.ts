import type {
  DetectedInventoryAiResult,
  LocationDescription,
  ProductIdentification,
} from "@cubby/schemas/ai";
import type { RecipeFlowAiPlan } from "@cubby/schemas/recipe-flow";

import {
  LOCATION_DESCRIPTION_FEATURE,
  LOCATION_INVENTORY_DETECTION_FEATURE,
  PRODUCT_IDENTIFICATION_FEATURE,
  RECIPE_FLOW_PRIMARY_FEATURE,
} from "~/server/ai/features";
import {
  type AiRunContext,
  runStructuredFeature,
} from "~/server/ai/run-feature";

/**
 * Every chat-tier method here is the same two lines: build the request, hand
 * it and the feature record to the one runner. Tier, model, token cap,
 * effort, cache policy, error surfacing, and usage accounting all live in
 * `features.ts` + `run-feature.ts`, so none of it is repeated per method.
 * Closed-set field picks (category, location type, put-away location, …) go
 * through `ai.suggestFields` / `FIELD_SUGGEST_REGISTRY` instead — see
 * `server/ai/field-suggest/`.
 */
class AiClient {
  async describeLocation(
    imageUrls: string[],
    locationName: string,
    ctx: AiRunContext,
  ): Promise<LocationDescription> {
    const request = LOCATION_DESCRIPTION_FEATURE.request(
      imageUrls,
      locationName,
    );
    return runStructuredFeature(LOCATION_DESCRIPTION_FEATURE, request, ctx);
  }

  async detectInventoryItems(
    imageUrls: string[],
    locationName: string,
    ctx: AiRunContext,
  ): Promise<DetectedInventoryAiResult> {
    const request = LOCATION_INVENTORY_DETECTION_FEATURE.request(
      imageUrls,
      locationName,
    );
    return runStructuredFeature(
      LOCATION_INVENTORY_DETECTION_FEATURE,
      request,
      ctx,
    );
  }

  async generateRecipeFlow(
    recipeJson: string,
    guidance: string | null,
    ctx: AiRunContext<RecipeFlowAiPlan>,
  ): Promise<RecipeFlowAiPlan> {
    const request = RECIPE_FLOW_PRIMARY_FEATURE.request(recipeJson, guidance);
    return runStructuredFeature(RECIPE_FLOW_PRIMARY_FEATURE, request, ctx);
  }

  async identifyProduct(
    imageUrls: string[],
    ctx: AiRunContext,
  ): Promise<ProductIdentification> {
    const request = PRODUCT_IDENTIFICATION_FEATURE.request(imageUrls);
    return runStructuredFeature(PRODUCT_IDENTIFICATION_FEATURE, request, ctx);
  }
}

// Singleton instance - lazy initialized
let aiClient: AiClient | null = null;

export function getAiClient(): AiClient {
  if (!aiClient) {
    aiClient = new AiClient();
  }
  return aiClient;
}
