import { z } from "zod";

/**
 * Cubby's AI model declarations: every model id a feature, usage row, agent,
 * or tool can name, with what each runtime needs to route it. Pure data with
 * no Worker, WASM, or pi-ai import, so tooling and schemas can derive from it.
 * Prices are not declared here: the runtime pricing client selects them from
 * the live catalog by each row's `catalogProvider` and id.
 */

/** The vendor a usage row is billed to (`AiUsage.provider`). */
const aiProviderSchema = z.enum([
  "anthropic",
  "openai",
  "typesafe",
  "cloudflare",
  "google-ai-studio",
]);
export type AiProvider = z.infer<typeof aiProviderSchema>;

/**
 * The gateway's provider segment — the first path element of a provider route
 * (`/anthropic/v1/messages`, `/openai/responses`, `/compat/chat/completions`).
 * `compat` is not a provider at all but the gateway's unified OpenAI-shaped
 * route, which is how Google AI Studio and Workers AI models are reached.
 */
export const gatewayProviderSchema = z.enum([
  "anthropic",
  "openai",
  "compat",
  "google-ai-studio",
  "workers-ai",
]);
export type GatewayProvider = z.infer<typeof gatewayProviderSchema>;

/** The gateway route a chat model's wire format rides. */
const chatGatewayProviderSchema = gatewayProviderSchema.extract([
  "openai",
  "anthropic",
]);
export type ChatGatewayProvider = z.infer<typeof chatGatewayProviderSchema>;

interface ModelDeclaration {
  provider: AiProvider;
  /** The pricing snapshot's provider id this model is priced under. */
  catalogProvider: string;
}

interface ChatModelDeclaration extends ModelDeclaration {
  role: "chat";
  /** `openai` is `/openai/responses`; `anthropic` is `/anthropic/v1/messages`. */
  gatewayProvider: ChatGatewayProvider;
  /** Explicit Cloudflare catalog id for the dedicated paid REST API. */
  unifiedModelId: string;
}

interface EmbeddingModelDeclaration extends ModelDeclaration {
  role: "embedding";
  provider: "openai";
  dimensions: number;
  maxInputTokens: number;
}

/**
 * A closed-set decision model on the gateway's native Workers AI route
 * (`ai/jev.ts`).
 */
interface DecisionModelDeclaration extends ModelDeclaration {
  role: "decision";
  provider: "typesafe" | "cloudflare";
  vision: boolean;
  /** Clef (the vision model) requires this selector in addition to its route model id. */
  selector?: string;
}

/**
 * A model only cookbook's pinned extraction ladder calls; declared so its
 * usage rows are priced. The upstream `cookbook` crate builds the request and
 * its catalog names these ids, so they are not app chat models.
 */
interface CookbookModelDeclaration extends ModelDeclaration {
  role: "cookbook";
  provider: "anthropic";
}

type AiModelDeclaration =
  | ChatModelDeclaration
  | EmbeddingModelDeclaration
  | DecisionModelDeclaration
  | CookbookModelDeclaration;

/** Every model Cubby can call, keyed by the id the provider itself wants. */
export const AI_MODELS = {
  "gpt-6-luna": {
    role: "chat",
    unifiedModelId: "openai/gpt-6-luna",
    provider: "openai",
    catalogProvider: "openai",
    gatewayProvider: "openai",
  },
  "gpt-6.1-terra": {
    role: "chat",
    unifiedModelId: "openai/gpt-6.1-terra",
    provider: "openai",
    catalogProvider: "openai",
    gatewayProvider: "openai",
  },
  "gpt-6.1-sol": {
    role: "chat",
    unifiedModelId: "openai/gpt-6.1-sol",
    provider: "openai",
    catalogProvider: "openai",
    gatewayProvider: "openai",
  },
  "claude-sonnet-5-5": {
    role: "chat",
    unifiedModelId: "anthropic/claude-sonnet-5.5",
    provider: "anthropic",
    catalogProvider: "anthropic",
    gatewayProvider: "anthropic",
  },
  // Haiku 5.5 rejects a thinking budget or a forced tool (400).
  "claude-haiku-5-5": {
    role: "chat",
    unifiedModelId: "anthropic/claude-haiku-5.5",
    provider: "anthropic",
    catalogProvider: "anthropic",
    gatewayProvider: "anthropic",
  },
  "text-embedding-3-small": {
    role: "embedding",
    provider: "openai",
    catalogProvider: "openai",
    dimensions: 1536,
    maxInputTokens: 8191,
  },
  "typesafe/jev": {
    role: "decision",
    provider: "typesafe",
    catalogProvider: "cloudflare-ai-gateway",
    vision: false,
  },
  "@cf/cloudflare/clef": {
    role: "decision",
    provider: "cloudflare",
    catalogProvider: "cloudflare-workers-ai",
    selector: "clef",
    vision: true,
  },
  "claude-sonnet-5": {
    role: "cookbook",
    provider: "anthropic",
    catalogProvider: "anthropic",
  },
  "claude-haiku-4-5": {
    role: "cookbook",
    provider: "anthropic",
    catalogProvider: "anthropic",
  },
} as const satisfies Record<string, AiModelDeclaration>;

type Declared = typeof AI_MODELS;
type ModelWhere<Criteria> = {
  [Id in keyof Declared]: Declared[Id] extends Criteria ? Id : never;
}[keyof Declared];

/** The declared ids whose row matches every `criteria` field, in declaration order. */
function idsWhere<const Criteria extends Partial<AiModelDeclaration>>(
  criteria: Criteria,
): ModelWhere<Criteria>[] {
  return Object.entries(AI_MODELS)
    .filter(([, row]) => {
      const fields = new Map(Object.entries(row));
      return Object.entries(criteria).every(
        ([key, value]) => fields.get(key) === value,
      );
    })
    .map(
      ([id]) =>
        // SAFETY: the filter kept only rows whose fields equal every literal
        // in `criteria`, which is exactly `Declared[Id] extends Criteria`.
        id as ModelWhere<Criteria>,
    );
}

export type AiModelId = keyof Declared;

export const supportedChatModelSchema = z.enum(idsWhere({ role: "chat" }));
export type SupportedChatModel = z.infer<typeof supportedChatModelSchema>;

/**
 * A chat model id read back from durable state (a coordinator's identity or
 * escalation decision). A retired id reads as absent, so its owner falls back
 * to the current declaration instead of failing to resume.
 */
export const storedChatModelSchema = z
  .string()
  .transform((id) => supportedChatModelSchema.safeParse(id).data);

const supportedEmbeddingModelSchema = z.enum(idsWhere({ role: "embedding" }));
export type SupportedEmbeddingModel = z.infer<
  typeof supportedEmbeddingModelSchema
>;

export const supportedDecisionModelSchema = z.enum(
  idsWhere({ role: "decision" }),
);
export type SupportedDecisionModel = z.infer<
  typeof supportedDecisionModelSchema
>;

/** Chat models reached over OpenAI's Responses API. */
export const openAiChatModelSchema = z.enum(
  idsWhere({ role: "chat", gatewayProvider: "openai" }),
);
export type OpenAiChatModel = z.infer<typeof openAiChatModelSchema>;

/** Chat models reached over Anthropic's Messages API. */
export const anthropicChatModelSchema = z.enum(
  idsWhere({ role: "chat", gatewayProvider: "anthropic" }),
);
type AnthropicChatModel = z.infer<typeof anthropicChatModelSchema>;

/** Every model a feature record can name. */
export type AiModel = SupportedChatModel | SupportedDecisionModel;

const chatTierSchema = z.enum(["fast", "standard", "quality"]);
/**
 * What a chat call needs from its model, not which model it is: `fast` for
 * interactive and bulk calls, `standard` for evidence that writes money,
 * `quality` where accuracy outweighs cost.
 */
export type ChatTier = z.infer<typeof chatTierSchema>;

/**
 * Each tier's model on each funding route (ADR 0027). The funding ladder asks
 * every source for its route's model of the requested tier; changing a tier's
 * model is one edit here. Anthropic has no model priced like Terra, so Sonnet
 * serves both upper tiers on Claude credit.
 */
export const CHAT_TIER_MODELS = {
  fast: { openai: "gpt-6-luna", anthropic: "claude-haiku-5-5" },
  standard: { openai: "gpt-6.1-terra", anthropic: "claude-sonnet-5-5" },
  quality: { openai: "gpt-6.1-sol", anthropic: "claude-sonnet-5-5" },
} as const satisfies Record<
  ChatTier,
  { openai: OpenAiChatModel; anthropic: AnthropicChatModel }
>;

/**
 * Callers name a tier by its OpenAI model: features, agent manifests and usage
 * rows keep one model id per tier, and the ladder substitutes the route's model.
 */
export const FAST_MODEL = CHAT_TIER_MODELS.fast.openai;
export const STANDARD_MODEL = CHAT_TIER_MODELS.standard.openai;
export const QUALITY_MODEL = CHAT_TIER_MODELS.quality.openai;

/** The tier a requested model names, if it names one. */
export function chatTierOf(model: SupportedChatModel): ChatTier | undefined {
  return chatTierSchema.options.find(
    (tier) => CHAT_TIER_MODELS[tier].openai === model,
  );
}
/**
 * The decision tier's baseline model: TypeSafe's Jev, a closed-set decision model
 * served through AI Gateway with TypeSafe BYOK rather than a chat endpoint, so it
 * is not a {@link SupportedChatModel} and takes no chat adapter.
 */
export const DECISION_MODEL = "typesafe/jev" satisfies SupportedDecisionModel;
/**
 * Media decisions need a vision model, which Jev is not. Clef serves only
 * questions that carry images; text decisions always use {@link DECISION_MODEL}.
 */
export const VISION_DECISION_MODEL =
  "@cf/cloudflare/clef" satisfies SupportedDecisionModel;

export const DEFAULT_EMBEDDING_MODEL =
  "text-embedding-3-small" satisfies SupportedEmbeddingModel;

/**
 * The reasoning dial OpenAI's Responses API accepts. GPT-6 (like gpt-5.1)
 * supports "none" to disable reasoning entirely; pi-ai's own type omits it
 * because most reasoning models reject it, but it forwards the raw string
 * to the wire unvalidated (`openai-responses.js`'s `reasoningEffort` branch).
 */
export const openAiEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type OpenAiEffort = z.infer<typeof openAiEffortSchema>;

/** The vendor a declared model's usage is billed to. */
export function providerFor(model: AiModelId): AiProvider {
  return AI_MODELS[model].provider;
}

/** A chat model's declaration, read through the wide row type. */
export function getChatModelConfig(
  model: SupportedChatModel,
): ChatModelDeclaration {
  return AI_MODELS[model];
}

export function getEmbeddingModelConfig(
  model: SupportedEmbeddingModel,
): EmbeddingModelDeclaration {
  return AI_MODELS[model];
}

export function getDecisionModelConfig(
  model: SupportedDecisionModel,
): DecisionModelDeclaration {
  return AI_MODELS[model];
}
