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
  vision: boolean;
  /**
   * Anthropic only: whether the model takes `thinking: {type: "adaptive"}` and
   * `output_config.effort`. Haiku 4.5 rejects both with a 400, so its options
   * carry only the token cap.
   */
  adaptiveThinking?: boolean;
}

interface EmbeddingModelDeclaration extends ModelDeclaration {
  role: "embedding";
  provider: "openai";
  dimensions: number;
}

/**
 * A closed-set decision model on the gateway's native Workers AI route
 * (`ai/jev.ts`).
 */
interface DecisionModelDeclaration extends ModelDeclaration {
  role: "decision";
  provider: "typesafe" | "cloudflare";
  /** Clef requires this selector in addition to its route model id. */
  selector?: string;
}

/**
 * A model only cookbook's pinned extraction ladder calls; declared so its
 * usage rows are priced. Not an app chat model, so it takes no chat adapter.
 */
interface CookbookModelDeclaration extends ModelDeclaration {
  role: "cookbook";
  provider: "google-ai-studio";
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
    provider: "openai",
    catalogProvider: "openai",
    gatewayProvider: "openai",
    vision: true,
  },
  "gpt-6-sol": {
    role: "chat",
    provider: "openai",
    catalogProvider: "openai",
    gatewayProvider: "openai",
    vision: true,
  },
  "claude-sonnet-5": {
    role: "chat",
    provider: "anthropic",
    catalogProvider: "anthropic",
    gatewayProvider: "anthropic",
    vision: true,
    adaptiveThinking: true,
  },
  "claude-opus-5-5": {
    role: "chat",
    provider: "anthropic",
    catalogProvider: "anthropic",
    gatewayProvider: "anthropic",
    vision: true,
    adaptiveThinking: true,
  },
  "claude-haiku-4-5": {
    role: "chat",
    provider: "anthropic",
    catalogProvider: "anthropic",
    gatewayProvider: "anthropic",
    vision: true,
    adaptiveThinking: false,
  },
  "text-embedding-3-small": {
    role: "embedding",
    provider: "openai",
    catalogProvider: "openai",
    dimensions: 1536,
  },
  "typesafe/jev": {
    role: "decision",
    provider: "typesafe",
    catalogProvider: "cloudflare-ai-gateway",
  },
  "@cf/cloudflare/clef": {
    role: "decision",
    provider: "cloudflare",
    catalogProvider: "cloudflare-workers-ai",
    selector: "clef",
  },
  "gemini-2.5-flash": {
    role: "cookbook",
    provider: "google-ai-studio",
    catalogProvider: "google",
  },
  "gemini-2.5-flash-lite": {
    role: "cookbook",
    provider: "google-ai-studio",
    catalogProvider: "google",
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

const supportedChatModelSchema = z.enum(idsWhere({ role: "chat" }));
export type SupportedChatModel = z.infer<typeof supportedChatModelSchema>;

const supportedEmbeddingModelSchema = z.enum(idsWhere({ role: "embedding" }));
export type SupportedEmbeddingModel = z.infer<
  typeof supportedEmbeddingModelSchema
>;

const supportedDecisionModelSchema = z.enum(idsWhere({ role: "decision" }));
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

/** The fast chat tier: interactive and bulk background calls. */
export const FAST_MODEL = "gpt-6-luna" satisfies OpenAiChatModel;
/**
 * The quality chat tier: calls whose accuracy outweighs latency (purchase
 * evidence, recipe flow, photo identity). Production reaches OpenAI through
 * the household's ChatGPT plan, so Sol's marginal cost there is ~$0; the
 * routing eval (`feature-routing-eval.live-eval.ts`) compares tiers.
 */
export const QUALITY_MODEL = "gpt-6-sol" satisfies OpenAiChatModel;
export const AUDIT_RECOVERY_MODEL =
  "claude-opus-5-5" satisfies AnthropicChatModel;
/**
 * The decision tier's baseline model: TypeSafe's Jev, a closed-set decision model
 * served by Workers AI over its native route rather than a chat one, so it
 * is not a {@link SupportedChatModel} and takes no chat adapter.
 */
export const DECISION_MODEL = "typesafe/jev" satisfies SupportedDecisionModel;
const CLEF_MODEL = "@cf/cloudflare/clef" satisfies SupportedDecisionModel;
/** Set to 0 to return all decisions to Jev, or 1 to send all to Clef. */
const CLEF_TRAFFIC_SHARE = 0.5;

export function selectDecisionModel(): SupportedDecisionModel {
  return Math.random() < 1 - CLEF_TRAFFIC_SHARE ? DECISION_MODEL : CLEF_MODEL;
}

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

/**
 * Whether `model` accepts adaptive thinking + effort. Read through the wide
 * row type on purpose: the literal row types only carry the flag where it is
 * declared, and every non-Anthropic row simply never sees Anthropic options.
 */
export function adaptiveThinkingFor(model: SupportedChatModel): boolean {
  return getChatModelConfig(model).adaptiveThinking ?? true;
}
