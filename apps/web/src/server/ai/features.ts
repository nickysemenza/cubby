/**
 * The one table of AI features.
 *
 * Every model call Cubby makes is declared here once — tier (which
 * decides the model), token cap, reasoning effort, whether the gateway may
 * cache it, the prompt version the AiAnalysis store keys on, and the schema
 * the model must return. `run-feature.ts` (or `jev.ts`) alone reads a
 * record to actually place a call, so a gateway-wide policy change (a cache
 * TTL, a new middleware, a tier's model) is one edit here or there rather
 * than ten copies of the same block across `clients/ai.ts`.
 *
 * `model` is DERIVED from `tier` ({@link MODEL_FOR_TIER}): retiering a
 * feature moves its model, and swapping a tier's model moves every feature on
 * it. The AiAnalysis fingerprint and cache key read `model` off the record,
 * so both follow automatically.
 */
import {
  type AiSelectionResult,
  aiSelectionResultSchema,
  type DetectedInventoryAiResult,
  detectedInventoryAiResultSchema,
  type LocationDescription,
  locationDescriptionSchema,
  type ProductIdentification,
  productIdentificationSchema,
} from "@cubby/schemas/ai";
import {
  type RecipeFlowAiPlan,
  recipeFlowAiPlanSchema,
  type RecipeFlowArtifact,
  recipeFlowArtifactSchema,
} from "@cubby/schemas/recipe-flow";
import type { z } from "zod";

import {
  type AiModel,
  type SupportedDecisionModel,
  DECISION_MODEL,
  FAST_MODEL,
  REASONING_MODEL,
  type SupportedChatModel,
  VISION_BATCH_MODEL,
} from "~/server/ai/models";
import type {
  AnthropicEffort,
  CompatEffort,
  OpenAiEffort,
} from "~/server/clients/ai-adapters";

/**
 * The three measured chat tiers a feature can be assigned to, plus the
 * decision tier: Jev answers one closed-set choice with a calibrated
 * probability over the options and writes no prose (`ai/jev.ts`).
 */
export type AiTier = "fast" | "visionBatch" | "reasoning" | "decision";

/**
 * The single place a tier's model is written down. `models.ts` owns the
 * constants; this owns which tier reaches for which.
 */
export const MODEL_FOR_TIER = {
  fast: FAST_MODEL,
  visionBatch: VISION_BATCH_MODEL,
  reasoning: REASONING_MODEL,
  decision: DECISION_MODEL,
} as const satisfies Record<AiTier, AiModel>;

interface AiFeatureShared {
  /** AI Gateway dashboard label, and the `AiUsage`/`AiAnalysis` feature key. */
  feature: string;
  /** Bumped when the prompt changes, to invalidate stored AiAnalysis rows. */
  promptVersion: string;
  /**
   * Whether the gateway may serve this call from its response cache. True for
   * every structured feature (they are deterministic on their request body);
   * the runner turns a caller's `force` into a skip. False only for the
   * streaming, tool-calling agent.
   */
  cache: boolean;
}

/**
 * A chat tier and its reasoning dial, typed by the provider-options helper
 * that will receive it — `effort: "none"` is valid on the fast tier and
 * rejected on the reasoning tier, at compile time.
 */
type AiChatFeatureTier = (
  | { tier: "fast"; effort: OpenAiEffort }
  | { tier: "visionBatch"; effort?: CompatEffort }
  | { tier: "reasoning"; effort?: AnthropicEffort }
) & {
  /** Output cap. Reasoning/thinking tokens count against it on every tier. */
  maxTokens: number;
};

/** The decision tier has no output to cap and no reasoning dial. */
type AiDecisionFeatureTier = { tier: "decision" };

type AiFeatureTier = AiChatFeatureTier | AiDecisionFeatureTier;

// `model` is derived from {@link MODEL_FOR_TIER}, never written by hand; it
// is typed per family so a chat runner can only ever be handed a chat model.
/** A feature placed over a chat route by `run-feature.ts`. */
export type AiChatFeature = AiFeatureShared &
  AiChatFeatureTier & { model: SupportedChatModel };
/** A feature placed as one closed-set choice by `ai/jev.ts`. */
export type AiDecisionFeature = AiFeatureShared &
  AiDecisionFeatureTier & { model: SupportedDecisionModel };
/** One feature's full declaration. A discriminated union on `tier`. */
export type AiFeature = AiChatFeature | AiDecisionFeature;

/** Distribute over {@link AiChatFeature}'s union so `switch (spec.tier)`
 * still narrows after the extra field is intersected on. Only chat features
 * carry a schema: a decision feature's answer is an index, not an object. */
type WithField<K extends string, T> = AiChatFeature extends infer F
  ? F extends AiChatFeature
    ? F & { [P in K]: z.ZodType<T> }
    : never
  : never;

/** A feature the structured runner can place: it declares its output schema. */
export type AiStructuredFeature<T> = WithField<"schema", T>;

/**
 * A feature whose result is persisted in `AiAnalysis`. `analysisSchema` is
 * the schema of the **stored** record, which is not always the model's own
 * output: recipe-flow stores a normalized artifact (plan + guidance +
 * provenance) built from the plan the model returned.
 */
export type AiAnalysisFeature<T> = WithField<"analysisSchema", T>;

/** Fill in the tier-derived `model`. */
function defineFeature<S extends AiFeatureShared & AiFeatureTier>(
  declaration: S,
): S & { model: (typeof MODEL_FOR_TIER)[S["tier"]] } {
  // SAFETY: indexing `MODEL_FOR_TIER` with a `S["tier"]`-typed value yields
  // exactly `(typeof MODEL_FOR_TIER)[S["tier"]]`, but the compiler widens the
  // lookup to the whole union because `S` is still a type parameter here.
  const model = MODEL_FOR_TIER[
    declaration.tier
  ] as (typeof MODEL_FOR_TIER)[S["tier"]];
  return { ...declaration, model };
}

// ---------------------------------------------------------------------------
// Decision tier — TypeSafe Jev on Workers AI. Closed-set classification and
// selection: the feature hands Jev a roster of choices and gets back one
// index plus a calibrated probability, so there is no id to echo and no
// prose to parse. A selection whose roster exceeds Jev's limit runs on
// `SELECTION_OVERFLOW_FEATURE` instead (`ai/selection.ts`).
// ---------------------------------------------------------------------------

export const PRODUCT_CATEGORY_SUGGESTION_FEATURE = defineFeature({
  feature: "product-category-suggestion",
  tier: "decision",
  cache: true,
  promptVersion: "2026-09-18.1",
}) satisfies AiDecisionFeature;

export const LOCATION_TYPE_SUGGESTION_FEATURE = defineFeature({
  feature: "location-type-suggestion",
  tier: "decision",
  cache: true,
  promptVersion: "2026-09-18.1",
}) satisfies AiDecisionFeature;

export const LOCATION_SUGGESTION_FEATURE = defineFeature({
  feature: "location-suggestion",
  tier: "decision",
  cache: true,
  promptVersion: "2026-09-18.1",
}) satisfies AiDecisionFeature;

export const USDA_FOOD_SUGGEST_FEATURE = defineFeature({
  feature: "usda-food-suggest",
  tier: "decision",
  cache: true,
  promptVersion: "2026-09-18.1",
}) satisfies AiDecisionFeature;

export const INGREDIENT_MERGE_FEATURE = defineFeature({
  feature: "ingredient-merge",
  tier: "decision",
  cache: true,
  promptVersion: "2026-09-18.1",
}) satisfies AiDecisionFeature;

// ---------------------------------------------------------------------------
// Fast tier — GPT-5.6 Luna. Identification, detection, and oversized
// selection.
// ---------------------------------------------------------------------------

/**
 * Where any `runAiSelection` lands when its roster is larger than the
 * decision tier takes in one choice: the model names the chosen candidate's
 * id from a rendered shortlist. Shared by every selection consumer; the
 * gateway metadata's `operation` says which one overflowed.
 */
export const SELECTION_OVERFLOW_FEATURE = defineFeature({
  feature: "selection-overflow",
  tier: "fast",
  maxTokens: 500,
  effort: "none",
  cache: true,
  promptVersion: "2026-09-11.1",
  schema: aiSelectionResultSchema,
}) satisfies AiStructuredFeature<AiSelectionResult>;

export const PRODUCT_IDENTIFICATION_FEATURE = defineFeature({
  feature: "product-identification",
  tier: "fast",
  maxTokens: 500,
  effort: "low",
  cache: true,
  promptVersion: "2026-09-11.1",
  schema: productIdentificationSchema,
}) satisfies AiStructuredFeature<ProductIdentification>;

export const LOCATION_INVENTORY_DETECTION_FEATURE = defineFeature({
  feature: "location-inventory-detection",
  tier: "fast",
  maxTokens: 2000,
  effort: "low",
  cache: true,
  promptVersion: "2026-09-11.1",
  schema: detectedInventoryAiResultSchema,
  analysisSchema: detectedInventoryAiResultSchema,
}) satisfies AiStructuredFeature<DetectedInventoryAiResult> &
  AiAnalysisFeature<DetectedInventoryAiResult>;

// ---------------------------------------------------------------------------
// Vision batch tier — Gemini 2.5 Flash. Cheap, accurate, ~14 s to first
// token: backfill only. No `effort`: keep Gemini's own thinking on.
// ---------------------------------------------------------------------------

export const LOCATION_DESCRIPTION_FEATURE = defineFeature({
  feature: "location-description",
  tier: "visionBatch",
  maxTokens: 1500,
  cache: true,
  promptVersion: "2026-09-11.1",
  schema: locationDescriptionSchema,
  analysisSchema: locationDescriptionSchema,
}) satisfies AiStructuredFeature<LocationDescription> &
  AiAnalysisFeature<LocationDescription>;

// ---------------------------------------------------------------------------
// Reasoning tier — Claude Sonnet 5. The accuracy tier.
// ---------------------------------------------------------------------------

export const RECIPE_FLOW_PRIMARY_FEATURE = defineFeature({
  feature: "recipe-flow",
  tier: "reasoning",
  maxTokens: 16000,
  effort: "low",
  cache: true,
  promptVersion: "2026-09-11.1",
  // The model returns a plan; the store holds the artifact built from it.
  schema: recipeFlowAiPlanSchema,
  analysisSchema: recipeFlowArtifactSchema,
}) satisfies AiStructuredFeature<RecipeFlowAiPlan> &
  AiAnalysisFeature<RecipeFlowArtifact>;

/**
 * The agent is declared here for its tier/cap/effort, but it does NOT run
 * through {@link runStructuredFeature}: it streams, calls tools across
 * several iterations, and has no output schema. `cache: false` — a
 * tool-calling conversation is not deterministic on its first request body.
 */
export const AGENT_ASK_FEATURE = defineFeature({
  feature: "agent-ask",
  tier: "reasoning",
  maxTokens: 4000,
  effort: "low",
  cache: false,
  promptVersion: "2026-09-11.1",
}) satisfies AiFeature;

/** Every declared feature, for the registry assertions in the unit test. */
export const AI_FEATURES = [
  PRODUCT_CATEGORY_SUGGESTION_FEATURE,
  LOCATION_TYPE_SUGGESTION_FEATURE,
  LOCATION_SUGGESTION_FEATURE,
  USDA_FOOD_SUGGEST_FEATURE,
  INGREDIENT_MERGE_FEATURE,
  SELECTION_OVERFLOW_FEATURE,
  PRODUCT_IDENTIFICATION_FEATURE,
  LOCATION_INVENTORY_DETECTION_FEATURE,
  LOCATION_DESCRIPTION_FEATURE,
  RECIPE_FLOW_PRIMARY_FEATURE,
  AGENT_ASK_FEATURE,
] as const satisfies readonly AiFeature[];

interface LocationAnalysisImageInput {
  id: string;
  updatedAt: Date;
}

export function buildLocationAnalysisFingerprint(
  feature: AiFeature,
  input: {
    locationName: string;
    images: LocationAnalysisImageInput[];
  },
): string {
  const images = [...input.images]
    .map((image) => ({
      id: image.id,
      updatedAt: image.updatedAt.toISOString(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return JSON.stringify({
    feature: feature.feature,
    model: feature.model,
    promptVersion: feature.promptVersion,
    locationName: input.locationName.trim(),
    images,
  });
}
