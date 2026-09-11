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

const aiProvider = z.enum(["anthropic", "openai", "google"]);
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

type AiModelConfig = ChatAiModelConfig | EmbeddingAiModelConfig;

const supportedChatModel = z.enum([
  "gpt-5.6-luna",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "claude-sonnet-5",
  "claude-haiku-4-5",
]);
export type SupportedChatModel = z.infer<typeof supportedChatModel>;

const supportedEmbeddingModel = z.enum(["text-embedding-3-small"]);
export type SupportedEmbeddingModel = z.infer<typeof supportedEmbeddingModel>;

const supportedAiModel = z.enum([
  ...supportedChatModel.options,
  ...supportedEmbeddingModel.options,
]);
type SupportedAiModel = z.infer<typeof supportedAiModel>;

/** The three measured tiers every feature is assigned to. */
export const FAST_MODEL = "gpt-5.6-luna" satisfies SupportedChatModel;
export const VISION_BATCH_MODEL =
  "gemini-2.5-flash" satisfies SupportedChatModel;
export const REASONING_MODEL = "claude-sonnet-5" satisfies SupportedChatModel;

export const DEFAULT_EMBEDDING_MODEL =
  "text-embedding-3-small" satisfies SupportedEmbeddingModel;

/**
 * Registered chat ids the crate catalog does not price. Every other chat row
 * must exist there and be `enabled` (`models.unit.test.ts` asserts it), so a
 * model added here without a catalog entry fails loudly instead of silently
 * recording null-cost usage.
 */
const UNCATALOGED_CHAT_MODELS =
  [] as const satisfies readonly SupportedChatModel[];

const AI_MODEL_REGISTRY = {
  "gpt-5.6-luna": {
    role: "chat",
    provider: "openai",
    route: "openai-responses",
    wireModel: "gpt-5.6-luna",
    vision: true,
  },
  "gemini-2.5-flash": {
    role: "chat",
    provider: "google",
    route: "compat",
    wireModel: "google-ai-studio/gemini-2.5-flash",
    vision: true,
  },
  "gemini-2.5-flash-lite": {
    role: "chat",
    provider: "google",
    route: "compat",
    wireModel: "google-ai-studio/gemini-2.5-flash-lite",
    vision: true,
  },
  "claude-sonnet-5": {
    role: "chat",
    provider: "anthropic",
    route: "anthropic",
    wireModel: "claude-sonnet-5",
    vision: true,
    adaptiveThinking: true,
  },
  "claude-haiku-4-5": {
    role: "chat",
    provider: "anthropic",
    route: "anthropic",
    wireModel: "claude-haiku-4-5",
    vision: true,
    adaptiveThinking: false,
  },
  "text-embedding-3-small": {
    role: "embedding",
    provider: "openai",
    dimensions: 1536,
    // Provider list price checked 2026-06-28.
    pricing: { inputUsdPerMillion: 0.02, outputUsdPerMillion: 0 },
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
  cache_read: z.number().nonnegative(),
  cache_write: z.number().nonnegative(),
});
const catalogEntrySchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
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
 * reported, or the crate catalog carries no rates for the model. Chat prices
 * come from the catalog (cache reads and writes included when the adapter
 * reports them); the embedding row is priced here.
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
  return (
    (inputTokens / 1_000_000) * rates.input +
    (outputTokens / 1_000_000) * rates.output +
    (finiteTokenCount(usage.cacheReadTokens) / 1_000_000) * rates.cache_read +
    (finiteTokenCount(usage.cacheWriteTokens) / 1_000_000) * rates.cache_write
  );
}

/** Chat ids the crate catalog is expected to price — the membership guard. */
export function catalogedChatModels(): SupportedChatModel[] {
  const uncataloged = new Set<string>(UNCATALOGED_CHAT_MODELS);
  return supportedChatModel.options.filter((model) => !uncataloged.has(model));
}
