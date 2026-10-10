/**
 * The one table of AI features.
 *
 * Every feature-runner call is declared here once — tier (which
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
  type ImageDescriptionResult,
  imageDescriptionResult,
} from "@cubby/schemas/image-processing";
import { mailboxRelevanceDecision } from "@cubby/schemas/mailbox-research";
import {
  type ImportAuditModelOutput,
  type ImportExtractionModelOutput,
  type OrderMailMessageClassification,
  importAuditModelOutput,
  importExtractionModelOutput,
  orderMailMessageClassification,
} from "@cubby/schemas/purchase-import";
import {
  type RecipeFlowAiPlan,
  recipeFlowAiPlanSchema,
  type RecipeFlowArtifact,
  recipeFlowArtifactSchema,
} from "@cubby/schemas/recipe-flow";
import { researchAssessment } from "@cubby/schemas/research-assessment";
import {
  type AiModel,
  DECISION_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  FAST_MODEL,
  type OpenAiEffort,
  QUALITY_MODEL,
  type SupportedChatModel,
  type SupportedDecisionModel,
  type SupportedEmbeddingModel,
} from "@cubby/shared/ai/models";
import type { z } from "zod";

/** Embeddings share the catalog, while retaining their vector runner. */
type AiTier = "fast" | "quality" | "decision" | "embedding";

/**
 * The single place a tier's model is written down. `models.ts` owns the
 * constants; this owns which tier reaches for which.
 */
const MODEL_FOR_TIER = {
  fast: FAST_MODEL,
  quality: QUALITY_MODEL,
  decision: DECISION_MODEL,
  embedding: DEFAULT_EMBEDDING_MODEL,
} as const satisfies Record<AiTier, AiModel | SupportedEmbeddingModel>;

interface AiFeatureShared {
  /** False retains usage metadata without archiving source prompts or replies. */
  collectPayload?: boolean;
  /** AI Gateway dashboard label, and the `AiUsage`/`AiAnalysis` feature key. */
  feature: string;
  /** Bumped when the prompt changes, to invalidate stored AiAnalysis rows. */
  promptVersion: string;
  /**
   * Whether the gateway may serve this call from its response cache (and the
   * application response cache may replay it). False sends an explicit skip;
   * a caller's `force` skips a cacheable call once.
   */
  cache: boolean;
}

/** A chat tier and its reasoning dial. */
type AiChatFeatureTier = {
  tier: "fast" | "quality";
  effort: OpenAiEffort;
} & {
  /** Output cap. Reasoning/thinking tokens count against it on every tier. */
  maxTokens: number;
};

/** The decision tier has no output to cap and no reasoning dial. */
type AiDecisionFeatureTier = { tier: "decision"; sample?: boolean };

type AiFeatureTier = AiChatFeatureTier | AiDecisionFeatureTier;
type AiEmbeddingFeatureTier = { tier: "embedding" };

// `model` is derived from {@link MODEL_FOR_TIER}, never written by hand; it
// is typed per family so a chat runner can only ever be handed a chat model.
/** A feature placed over a chat route by `run-feature.ts`. */
export type AiChatFeature = AiFeatureShared &
  AiChatFeatureTier & { model: SupportedChatModel };
/** A feature placed as one closed-set choice by `ai/jev.ts`. */
export type AiDecisionFeature = AiFeatureShared &
  AiDecisionFeatureTier & { model: SupportedDecisionModel };
export type AiEmbeddingFeature = AiFeatureShared &
  AiEmbeddingFeatureTier & { model: typeof DEFAULT_EMBEDDING_MODEL };
/** One feature's full declaration. A discriminated union on `tier`. */
export type AiFeature = AiChatFeature | AiDecisionFeature | AiEmbeddingFeature;

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
function defineFeature<
  S extends AiFeatureShared & (AiFeatureTier | AiEmbeddingFeatureTier),
>(declaration: S): S & { model: (typeof MODEL_FOR_TIER)[S["tier"]] } {
  // SAFETY: indexing `MODEL_FOR_TIER` with a `S["tier"]`-typed value yields
  // exactly `(typeof MODEL_FOR_TIER)[S["tier"]]`, but the compiler widens the
  // lookup to the whole union because `S` is still a type parameter here.
  const model = MODEL_FOR_TIER[
    declaration.tier
  ] as (typeof MODEL_FOR_TIER)[S["tier"]];
  return { ...declaration, model };
}

// ---------------------------------------------------------------------------
// Decision tier — Jev/Clef trial on Workers AI. Closed-set classification and
// selection: the feature hands the model a roster of choices and gets back one
// index plus a calibrated probability, so there is no id to echo and no
// prose to parse. A selection whose roster exceeds Jev's limit runs on
// `SELECTION_OVERFLOW_FEATURE` instead (`ai/selection.ts`).
// ---------------------------------------------------------------------------

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

/**
 * Every `ai.suggestFields` target — enum classification and reference/text
 * selection alike — runs as this one feature. Per-target telemetry comes from
 * `AiRunContext.operation` (`suggestFields.<entity>.<field>`), not a
 * per-field feature record, so adding a field to
 * `FIELD_SUGGEST_REGISTRY` (`field-suggest/registry.ts`) needs no new entry
 * here.
 */
export const FIELD_SUGGESTION_FEATURE = defineFeature({
  feature: "field-suggestion",
  tier: "decision",
  cache: true,
  promptVersion: "2026-09-18.1",
}) satisfies AiDecisionFeature;

/**
 * Orders statement transactions that the deterministic settlement ranking
 * ties for a Purchase. Person-triggered and advisory: it orders a review and
 * never writes an allocation.
 */
export const SETTLEMENT_CANDIDATE_RANK_FEATURE = defineFeature({
  feature: "settlement-candidate-rank",
  tier: "decision",
  cache: true,
  promptVersion: "2026-10-02.1",
}) satisfies AiDecisionFeature;

export const MAILBOX_TRIAGE_FEATURE = defineFeature({
  feature: "mailbox-triage",
  promptVersion: "2026-10-07.1",
  cache: false,
  tier: "decision",
  sample: false,
  collectPayload: false,
});

export const MAILBOX_RELEVANCE_FEATURE = defineFeature({
  feature: "mailbox-relevance",
  promptVersion: "2026-10-07.1",
  cache: false,
  collectPayload: false,
  tier: "fast",
  effort: "medium",
  maxTokens: 1500,
  schema: mailboxRelevanceDecision,
});

export const RESEARCH_SUPPORT_FEATURE = defineFeature({
  feature: "research-source-support",
  promptVersion: "2026-10-09.2",
  cache: false,
  collectPayload: false,
  tier: "quality",
  effort: "low",
  maxTokens: 6_000,
  schema: researchAssessment,
});

export const PURCHASE_IMPORT_PRODUCT_IDENTITY_FEATURE = defineFeature({
  feature: "product-line-identity",
  tier: "decision",
  cache: true,
  promptVersion: "2026-09-19.1",
}) satisfies AiDecisionFeature;

export const PURCHASE_IMPORT_EXPENSE_LINE_ROLE_FEATURE = defineFeature({
  feature: "expense-line-role",
  tier: "decision",
  cache: true,
  promptVersion: "2026-09-19.1",
}) satisfies AiDecisionFeature;

export const PURCHASE_IMPORT_KIT_DETECTION_FEATURE = defineFeature({
  feature: "kit-detection",
  tier: "decision",
  cache: true,
  promptVersion: "2026-09-19.1",
}) satisfies AiDecisionFeature;

export const PURCHASE_IMPORT_PRODUCT_PROMOTION_FEATURE = defineFeature({
  feature: "product-promotion",
  tier: "decision",
  cache: true,
  promptVersion: "2026-09-19.1",
}) satisfies AiDecisionFeature;

export const PURCHASE_IMPORT_REVERSAL_KIND_FEATURE = defineFeature({
  feature: "reversal-kind",
  tier: "decision",
  cache: true,
  promptVersion: "2026-09-19.1",
}) satisfies AiDecisionFeature;

// ---------------------------------------------------------------------------
// Chat tiers. Quality — GPT-6 Sol: purchase evidence (extraction, receipts,
// mail classification, audit, repair), recipe flow, and photo identity and
// detection. Fast — GPT-6 Luna: oversized selection and bulk descriptions.
// Production reaches OpenAI through the household's ChatGPT plan, where Sol's
// marginal cost is about zero (`docs/infrastructure.md`).
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
  tier: "quality",
  maxTokens: 500,
  effort: "low",
  cache: true,
  promptVersion: "2026-09-11.1",
  schema: productIdentificationSchema,
}) satisfies AiStructuredFeature<ProductIdentification>;

export const LOCATION_INVENTORY_DETECTION_FEATURE = defineFeature({
  feature: "location-inventory-detection",
  tier: "quality",
  maxTokens: 2000,
  effort: "low",
  cache: true,
  promptVersion: "2026-09-11.1",
  schema: detectedInventoryAiResultSchema,
  analysisSchema: detectedInventoryAiResultSchema,
}) satisfies AiStructuredFeature<DetectedInventoryAiResult> &
  AiAnalysisFeature<DetectedInventoryAiResult>;

export const PURCHASE_IMPORT_EXTRACTION_FEATURE = defineFeature({
  feature: "purchase-import-extraction",
  tier: "quality",
  maxTokens: 4_000,
  effort: "low",
  cache: false,
  promptVersion: "2026-10-06.1",
  schema: importExtractionModelOutput,
}) satisfies AiStructuredFeature<ImportExtractionModelOutput>;

export const PURCHASE_IMPORT_RECEIPT_FEATURE = defineFeature({
  feature: "purchase-import-receipt-extraction",
  tier: "quality",
  maxTokens: 4_000,
  effort: "low",
  cache: false,
  promptVersion: "2026-09-19.1",
  schema: importExtractionModelOutput,
}) satisfies AiStructuredFeature<ImportExtractionModelOutput>;

export const PURCHASE_IMPORT_MAIL_FEATURE = defineFeature({
  feature: "purchase-import-mail-classification",
  tier: "quality",
  maxTokens: 1_000,
  effort: "low",
  cache: true,
  promptVersion: "2026-09-27.1",
  schema: orderMailMessageClassification,
}) satisfies AiStructuredFeature<OrderMailMessageClassification>;

/**
 * On Sol again since 2026-10-06: judged the better model, and the ChatGPT plan
 * made its cost moot.
 * History: moved from Sol after `eval:features` (2026-10-04): Luna at high effort
 * matched Sol high 12/16 with zero unsafe answers on both, at about 1/19 of
 * the cost. Its schema still carries no array bounds: a failed call is
 * retried on the Anthropic recovery model (`extract.ts`).
 */
export const PURCHASE_IMPORT_AUDIT_FEATURE = defineFeature({
  feature: "purchase-import-audit",
  tier: "quality",
  maxTokens: 8_000,
  effort: "high",
  cache: true,
  promptVersion: "2026-09-19.1",
  schema: importAuditModelOutput,
}) satisfies AiStructuredFeature<ImportAuditModelOutput>;

/**
 * On Sol again since 2026-10-06: judged the better model, and the ChatGPT plan
 * made its cost moot.
 * History: moved from Sol after `eval:features` (2026-10-04): Luna at high effort
 * matched Sol high 14/14 with zero unsafe repairs (no line invented, moved,
 * or scaled to balance a total), at about 1/19 of the cost. The eval's cases
 * are text-only; production also attaches the capture's screenshot, which
 * that parity does not cover.
 */
export const PURCHASE_IMPORT_REPAIR_FEATURE = defineFeature({
  feature: "purchase-import-repair",
  tier: "quality",
  maxTokens: 4_000,
  effort: "high",
  cache: false,
  promptVersion: "2026-09-19.1",
  schema: importExtractionModelOutput,
}) satisfies AiStructuredFeature<ImportExtractionModelOutput>;

/**
 * On Sol again since 2026-10-06: judged the better model, and the ChatGPT plan
 * made its cost moot.
 * History: moved from Sol low after `eval:features` (2026-10-04): Luna at high effort
 * matched it 10/10 with zero unsafe plans (no number a step's own evidence
 * does not state), at about 1/13 of the cost and roughly twice the latency.
 * Flows a previous model stored stay current (`recipe-flow.service.ts`).
 */
export const RECIPE_FLOW_PRIMARY_FEATURE = defineFeature({
  feature: "recipe-flow",
  tier: "quality",
  maxTokens: 16000,
  effort: "high",
  cache: true,
  promptVersion: "2026-09-11.1",
  // The model returns a plan; the store holds the artifact built from it.
  schema: recipeFlowAiPlanSchema,
  analysisSchema: recipeFlowArtifactSchema,
}) satisfies AiStructuredFeature<RecipeFlowAiPlan> &
  AiAnalysisFeature<RecipeFlowArtifact>;

// ---------------------------------------------------------------------------
// Vision descriptions. Moved from Gemini 2.5 Flash (2026-10-05), which
// rejected the description schema as too complex to constrain (HTTP 400);
// Luna is cheaper per token and already reads images for product
// identification and the photo agent.
// ---------------------------------------------------------------------------

export const LOCATION_DESCRIPTION_FEATURE = defineFeature({
  feature: "location-description",
  tier: "fast",
  maxTokens: 1500,
  effort: "low",
  cache: true,
  promptVersion: "2026-09-11.1",
  schema: locationDescriptionSchema,
  analysisSchema: locationDescriptionSchema,
}) satisfies AiStructuredFeature<LocationDescription> &
  AiAnalysisFeature<LocationDescription>;

/** Cloud is the preferred image-description provider until an explicit policy changes it. */
export const IMAGE_DESCRIPTION_FEATURE = defineFeature({
  feature: "image-description",
  tier: "fast",
  maxTokens: 2_500,
  effort: "low",
  cache: true,
  promptVersion: "2",
  schema: imageDescriptionResult,
  analysisSchema: imageDescriptionResult,
}) satisfies AiStructuredFeature<ImageDescriptionResult> &
  AiAnalysisFeature<ImageDescriptionResult>;

export const SEMANTIC_QUERY_FEATURE = defineFeature({
  feature: "semantic-query",
  tier: "embedding",
  cache: true,
  promptVersion: "1",
}) satisfies AiEmbeddingFeature;

export const ENTITY_EMBEDDING_FEATURE = defineFeature({
  feature: "entity-embedding",
  tier: "embedding",
  cache: true,
  promptVersion: "1",
}) satisfies AiEmbeddingFeature;

/** Every declared feature, for the registry assertions in the unit test. */
export const AI_FEATURES = [
  RESEARCH_SUPPORT_FEATURE,
  MAILBOX_TRIAGE_FEATURE,
  MAILBOX_RELEVANCE_FEATURE,
  USDA_FOOD_SUGGEST_FEATURE,
  INGREDIENT_MERGE_FEATURE,
  FIELD_SUGGESTION_FEATURE,
  SETTLEMENT_CANDIDATE_RANK_FEATURE,
  PURCHASE_IMPORT_PRODUCT_IDENTITY_FEATURE,
  PURCHASE_IMPORT_EXPENSE_LINE_ROLE_FEATURE,
  PURCHASE_IMPORT_KIT_DETECTION_FEATURE,
  PURCHASE_IMPORT_PRODUCT_PROMOTION_FEATURE,
  PURCHASE_IMPORT_REVERSAL_KIND_FEATURE,
  SELECTION_OVERFLOW_FEATURE,
  PRODUCT_IDENTIFICATION_FEATURE,
  LOCATION_INVENTORY_DETECTION_FEATURE,
  PURCHASE_IMPORT_EXTRACTION_FEATURE,
  PURCHASE_IMPORT_RECEIPT_FEATURE,
  PURCHASE_IMPORT_MAIL_FEATURE,
  LOCATION_DESCRIPTION_FEATURE,
  IMAGE_DESCRIPTION_FEATURE,
  RECIPE_FLOW_PRIMARY_FEATURE,
  PURCHASE_IMPORT_AUDIT_FEATURE,
  PURCHASE_IMPORT_REPAIR_FEATURE,
  SEMANTIC_QUERY_FEATURE,
  ENTITY_EMBEDDING_FEATURE,
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
