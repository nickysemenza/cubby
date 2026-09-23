import { z } from "zod";

import { wasm } from "~/lib/wasm";

interface AiTokenUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Tokens served from the provider's prompt cache, when it reports them. */
  cacheReadTokens?: number | null;
  /** Tokens written into the provider's prompt cache, when it reports them. */
  cacheWriteTokens?: number | null;
}

const aiProvider = z.enum(["anthropic", "openai", "google", "typesafe"]);
type AiProvider = z.infer<typeof aiProvider>;

/**
 * The wire format a chat model is reached over, mirroring the cookbook crate's
 * `Route` enum: `anthropic` is `/anthropic/v1/messages`, `openai-responses` is
 * `/openai/responses`, and `compat` is the gateway's unified
 * `/compat/chat/completions` (the only path to Google AI Studio).
 */
const chatRoute = z.enum(["anthropic", "openai-responses", "compat"]);
type ChatRoute = z.infer<typeof chatRoute>;

interface ChatAiModelConfig {
  role: "chat";
  provider: AiProvider;
  route: ChatRoute;
  /** The id the provider itself wants; `compat` prefixes the gateway vendor. */
  wireModel: string;
  vision: boolean;
  /** Provider USD-per-million prompt-cache rates for normalized cache tokens. */
  cachePricing?: { read: number; write: number };
  /**
   * Anthropic only: whether the model takes `thinking: {type: "adaptive"}` and
   * `output_config.effort`. Haiku 4.5 rejects both with a 400, so its options
   * carry only the token cap.
   */
  adaptiveThinking?: boolean;
}

interface EmbeddingAiModelConfig {
  role: "embedding";
  provider: "openai";
  dimensions: number;
  /** Embeddings are not in the crate catalog, so their price stays here. */
  pricing: { inputUsdPerMillion: number; outputUsdPerMillion: number };
}

/**
 * A closed-set decision model on the gateway's native Workers AI route
 * (`ai/jev.ts`); priced from the crate catalog like a chat model.
 */
interface DecisionAiModelConfig {
  role: "decision";
  provider: "typesafe";
}

type AiModelConfig =
  | ChatAiModelConfig
  | EmbeddingAiModelConfig
  | DecisionAiModelConfig;

const supportedChatModel = z.enum([
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "claude-sonnet-5",
  "claude-opus-5-5",
  "claude-haiku-4-5",
]);
export type SupportedChatModel = z.infer<typeof supportedChatModel>;

const supportedEmbeddingModel = z.enum(["text-embedding-3-small"]);
export type SupportedEmbeddingModel = z.infer<typeof supportedEmbeddingModel>;

const supportedDecisionModel = z.enum(["typesafe/jev"]);
export type SupportedDecisionModel = z.infer<typeof supportedDecisionModel>;

const supportedAiModel = z.enum([
  ...supportedChatModel.options,
  ...supportedEmbeddingModel.options,
  ...supportedDecisionModel.options,
]);
type SupportedAiModel = z.infer<typeof supportedAiModel>;

/** The three measured tiers every feature is assigned to. */
export const FAST_MODEL = "gpt-6-luna" satisfies SupportedChatModel;
export const VISION_BATCH_MODEL =
  "gemini-2.5-flash" satisfies SupportedChatModel;
export const REASONING_MODEL = "gpt-6-sol" satisfies SupportedChatModel;
export const AUDIT_RECOVERY_MODEL =
  "claude-opus-5-5" satisfies SupportedChatModel;
/**
 * The decision tier's model: TypeSafe's Jev, a closed-set decision model
 * served by Workers AI over its native route rather than a chat one, so it
 * is not a {@link SupportedChatModel} and takes no chat adapter.
 */
export const DECISION_MODEL = "typesafe/jev" satisfies SupportedDecisionModel;
/** Every model a feature record can name. */
export type AiModel = SupportedChatModel | SupportedDecisionModel;

export const DEFAULT_EMBEDDING_MODEL =
  "text-embedding-3-small" satisfies SupportedEmbeddingModel;

/**
 * Registered chat/decision ids the crate catalog does not price. Every other
 * such row must exist there (`models.unit.test.ts` asserts it), so a model
 * added here without a catalog entry fails loudly instead of silently
 * recording null-cost usage.
 */
// Flue records the provider-reported total for its Terra/Sol turns. They are
// intentionally usable through the shared Gateway registry even while the
// cookbook catalog remains focused on extraction tiers.
const UNCATALOGED_MODELS = [
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const satisfies readonly AiModel[];

const AI_MODEL_REGISTRY = {
  "gpt-6-luna": {
    role: "chat",
    provider: "openai",
    route: "openai-responses",
    wireModel: "gpt-6-luna",
    vision: true,
    cachePricing: { read: 0.01, write: 0.125 },
  },
  "gpt-6-sol": {
    role: "chat",
    provider: "openai",
    route: "openai-responses",
    wireModel: "gpt-6-sol",
    vision: true,
    cachePricing: { read: 0.2, write: 2.5 },
  },
  "gpt-5.6-luna": {
    role: "chat",
    provider: "openai",
    route: "openai-responses",
    wireModel: "gpt-5.6-luna",
    vision: true,
    cachePricing: { read: 0.1, write: 1.25 },
  },
  "gpt-5.6-terra": {
    role: "chat",
    provider: "openai",
    route: "openai-responses",
    wireModel: "gpt-5.6-terra",
    vision: true,
    cachePricing: { read: 0.25, write: 3.125 },
  },
  "gpt-5.6-sol": {
    role: "chat",
    provider: "openai",
    route: "openai-responses",
    wireModel: "gpt-5.6-sol",
    vision: true,
    cachePricing: { read: 0.5, write: 6.25 },
  },
  "gemini-2.5-flash": {
    role: "chat",
    provider: "google",
    route: "compat",
    wireModel: "google-ai-studio/gemini-2.5-flash",
    vision: true,
    cachePricing: { read: 0.03, write: 0 },
  },
  "gemini-2.5-flash-lite": {
    role: "chat",
    provider: "google",
    route: "compat",
    wireModel: "google-ai-studio/gemini-2.5-flash-lite",
    vision: true,
    cachePricing: { read: 0.01, write: 0 },
  },
  "claude-sonnet-5": {
    role: "chat",
    provider: "anthropic",
    route: "anthropic",
    wireModel: "claude-sonnet-5",
    vision: true,
    cachePricing: { read: 0.2, write: 2.5 },
    adaptiveThinking: true,
  },
  "claude-opus-5-5": {
    role: "chat",
    provider: "anthropic",
    route: "anthropic",
    wireModel: "claude-opus-5-5",
    vision: true,
    cachePricing: { read: 0.2, write: 5 },
    adaptiveThinking: true,
  },
  "claude-haiku-4-5": {
    role: "chat",
    provider: "anthropic",
    route: "anthropic",
    wireModel: "claude-haiku-4-5",
    vision: true,
    cachePricing: { read: 0.1, write: 1.25 },
    adaptiveThinking: false,
  },
  "text-embedding-3-small": {
    role: "embedding",
    provider: "openai",
    dimensions: 1536,
    // Provider list price checked 2026-06-28.
    pricing: { inputUsdPerMillion: 0.02, outputUsdPerMillion: 0 },
  },
  "typesafe/jev": {
    role: "decision",
    provider: "typesafe",
  },
} as const satisfies Record<SupportedAiModel, AiModelConfig>;

export type SupportedAiModelRef = {
  [Model in SupportedAiModel]: {
    provider: (typeof AI_MODEL_REGISTRY)[Model]["provider"];
    model: Model;
  };
}[SupportedAiModel];

/**
 * The cookbook crate's measured model catalog (`wasm.model_catalog()`), the
 * single price source for every chat model Cubby calls. Only the fields the
 * app reads are declared; the crate row carries labels, priors, and sources
 * too.
 */
const catalogRatesSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
});
const catalogEntrySchema = z.object({
  id: z.string().min(1),
  /** USD per million tokens, or absent for a model the crate cannot price. */
  rates: catalogRatesSchema.nullish(),
});
const catalogSchema = z.array(catalogEntrySchema);

export type AiModelCatalogEntry = z.output<typeof catalogEntrySchema>;

// Memoized per isolate: the catalog is a static table in the WASM module, and
// parsing it on every priced row would dominate the telemetry write path.
let catalogById: ReadonlyMap<string, AiModelCatalogEntry> | undefined;

export function getAiModelCatalog(): ReadonlyMap<string, AiModelCatalogEntry> {
  if (!catalogById) {
    const parsed = catalogSchema.safeParse(wasm.model_catalog());
    if (!parsed.success) {
      // Never fail the caller: pricing is telemetry, and an unpriced row is
      // already a visible state on /ai-usage. Cached so this logs once.
      console.error("[ai/models] crate model catalog did not parse", {
        error: parsed.error.message,
      });
    }
    catalogById = new Map(
      (parsed.success ? parsed.data : []).map((entry) => [entry.id, entry]),
    );
  }
  return catalogById;
}

function finiteTokenCount(value: number | null | undefined): number {
  return value !== null && value !== undefined && Number.isFinite(value)
    ? value
    : 0;
}

function isSupportedAiModel(model: string): model is SupportedAiModel {
  return supportedAiModel.safeParse(model).success;
}

/**
 * The routing row for a chat model. Generic so the literal `wireModel` and
 * `route` survive: `clients/ai-adapters.ts` needs the exact provider model id
 * to type its adapters, and narrows on `route`.
 */
export function getChatModelConfig<Model extends SupportedChatModel>(
  model: Model,
): (typeof AI_MODEL_REGISTRY)[Model] {
  return AI_MODEL_REGISTRY[model];
}

/**
 * Whether `model` accepts adaptive thinking + effort. Read through the wide
 * row type on purpose: the literal row types only carry the flag where it is
 * declared, and every non-Anthropic row simply never sees Anthropic options.
 */
export function adaptiveThinkingFor(model: SupportedChatModel): boolean {
  const config: ChatAiModelConfig = AI_MODEL_REGISTRY[model];
  return config.adaptiveThinking ?? true;
}

export function providerFor(model: SupportedChatModel): AiProvider {
  return AI_MODEL_REGISTRY[model].provider;
}

export function getEmbeddingModelConfig(
  model: SupportedEmbeddingModel,
): EmbeddingAiModelConfig {
  return AI_MODEL_REGISTRY[model];
}

export function parseSupportedEmbeddingModel(
  model: string,
): SupportedEmbeddingModel {
  const parsed = supportedEmbeddingModel.safeParse(model);
  if (!parsed.success) {
    throw new Error(
      `Unsupported embedding model "${model}". Add it to AI_MODEL_REGISTRY with provider, dimensions, and pricing before use.`,
    );
  }
  return parsed.data;
}

/**
 * What one recorded call cost, or `null` when the model is unknown to the
 * registry, the recorded provider disagrees with it, no token counts were
 * reported, or the catalog cannot price the exact token classes. Chat and
 * decision base prices come from the catalog. Chat cache tokens use the
 * provider-specific rates in the registry; an adapter-reported exact total
 * still wins when the usage row is recorded. The embedding row is priced here.
 */
export function estimateAiUsageCostUsd(
  provider: string,
  model: string,
  usage: AiTokenUsage,
): number | null {
  if (!isSupportedAiModel(model)) return null;
  const config = AI_MODEL_REGISTRY[model];
  if (config.provider !== provider) return null;
  if (usage.inputTokens == null && usage.outputTokens == null) return null;

  const inputTokens = finiteTokenCount(usage.inputTokens);
  const outputTokens = finiteTokenCount(usage.outputTokens);
  if (config.role === "embedding") {
    return (
      (inputTokens / 1_000_000) * config.pricing.inputUsdPerMillion +
      (outputTokens / 1_000_000) * config.pricing.outputUsdPerMillion
    );
  }

  const rates = getAiModelCatalog().get(model)?.rates;
  if (!rates) return null;
  const cacheReadTokens = finiteTokenCount(usage.cacheReadTokens);
  const cacheWriteTokens = finiteTokenCount(usage.cacheWriteTokens);
  const cachePricing = config.role === "chat" ? config.cachePricing : undefined;
  if ((cacheReadTokens > 0 || cacheWriteTokens > 0) && !cachePricing)
    return null;
  return (
    (inputTokens / 1_000_000) * rates.input +
    (outputTokens / 1_000_000) * rates.output +
    (cacheReadTokens / 1_000_000) * (cachePricing?.read ?? 0) +
    (cacheWriteTokens / 1_000_000) * (cachePricing?.write ?? 0)
  );
}

/** Ids the crate catalog is expected to price — the membership guard. */
export function catalogedModels(): AiModel[] {
  const uncataloged = new Set<string>(UNCATALOGED_MODELS);
  return [
    ...supportedChatModel.options,
    ...supportedDecisionModel.options,
  ].filter((model) => !uncataloged.has(model));
}
