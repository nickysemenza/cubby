/**
 * Feature identities that persisted rows are stamped with, and the tier table
 * every feature record derives its model from. Repos compare stored stamps
 * against these without loading prompt builders or model runners; the
 * runnable records live in `ai/features.ts`.
 */
import {
  type AiModel,
  type ChatTier,
  DECISION_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  FAST_MODEL,
  type OpenAiEffort,
  QUALITY_MODEL,
  STANDARD_MODEL,
  type SupportedChatModel,
  type SupportedDecisionModel,
  type SupportedEmbeddingModel,
} from "@cubby/shared/ai/models";
import type { z } from "zod";

// Request shapes stay with declarations so repository policy never imports execution.
/** One part of a user message's content: text, or an image/document fetched by URL. */
interface AiTextPart {
  type: "text";
  content: string;
}
export interface AiImagePart {
  type: "image";
  source:
    | { type: "url"; value: string; mimeType?: string }
    | { type: "inline"; value: string; mimeType: string };
}
/** A document (e.g. a PDF receipt). Resolved the same way as an image — see
 * the runner's media resolution — since pi-ai's `Message` has no document
 * content type; the shared OpenAI provider (`@cubby/shared/ai/pi-providers`)
 * rewrites the resulting PDF image block into the Responses `input_file`. */
export interface AiDocumentPart {
  type: "document";
  source: { type: "url" | "inline"; value: string; mimeType: string };
}
export type AiContentPart = AiTextPart | AiImagePart | AiDocumentPart;
/** Every message `runStructuredFeature` sends is a single-turn user prompt —
 * no caller here carries a multi-turn conversation with prior assistant
 * turns, so this intentionally only models `role: "user"`. */
export interface AiMessage {
  role: "user";
  content: string | AiContentPart[];
}

/** Everything a `chat()` call needs that the feature record does not own:
 * the prompt itself. Request builders in `clients/ai.ts` return this. */
export interface AiChatRequest {
  systemPrompts: string[];
  messages: AiMessage[];
}

/** Embeddings share the catalog, while retaining their vector runner. */
type AiTier = ChatTier | "decision" | "embedding";

/**
 * The model id each tier's features are stamped with. Chat tiers name their
 * OpenAI model; the funding ladder substitutes each route's model
 * (`CHAT_TIER_MODELS`).
 */
export const MODEL_FOR_TIER = {
  fast: FAST_MODEL,
  standard: STANDARD_MODEL,
  quality: QUALITY_MODEL,
  decision: DECISION_MODEL,
  embedding: DEFAULT_EMBEDDING_MODEL,
} as const satisfies Record<AiTier, AiModel | SupportedEmbeddingModel>;

export interface AiFeatureShared {
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
  tier: ChatTier;
  effort: OpenAiEffort;
} & {
  /** Output cap. Reasoning/thinking tokens count against it on every tier. */
  maxTokens: number;
};

/** The decision tier has no output to cap and no reasoning dial. */
type AiDecisionFeatureTier = { tier: "decision" };

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
export function defineFeature<
  S extends AiFeatureShared &
    (
      | (AiChatFeatureTier & { request: (...args: never[]) => AiChatRequest })
      | AiDecisionFeatureTier
      | AiEmbeddingFeatureTier
    ),
>(declaration: S): S & { model: (typeof MODEL_FOR_TIER)[S["tier"]] } {
  // SAFETY: indexing `MODEL_FOR_TIER` with a `S["tier"]`-typed value yields
  // exactly `(typeof MODEL_FOR_TIER)[S["tier"]]`, but the compiler widens the
  // lookup to the whole union because `S` is still a type parameter here.
  const model = MODEL_FOR_TIER[
    declaration.tier
  ] as (typeof MODEL_FOR_TIER)[S["tier"]];
  return { ...declaration, model };
}

export const PRODUCT_IDENTITY_RULE_REVISION = "identity-v7";
export const PRODUCT_IDENTITY_FEATURE = defineFeature({
  feature: "product-identity",
  tier: "decision",
  cache: true,
  promptVersion: "2026-10-20.1",
}) satisfies AiDecisionFeature;

/** `IMAGE_DESCRIPTION_FEATURE`'s stamp: cloud description jobs and caches key on it. */
export const IMAGE_DESCRIPTION_IDENTITY = {
  feature: "image-description",
  tier: "fast",
  model: MODEL_FOR_TIER.fast,
} as const;

/** `RECIPE_FLOW_PRIMARY_FEATURE`'s stamp: stored flows are read back by it. */
export const RECIPE_FLOW_IDENTITY = {
  feature: "recipe-flow",
  promptVersion: "2026-09-11.1",
} as const;
