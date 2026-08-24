import { z } from "zod";

interface AiTokenUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
}

interface AiModelPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

interface BaseAiModelConfig {
  provider: AiProvider;
  pricing: AiModelPricing;
}

interface ChatAiModelConfig extends BaseAiModelConfig {
  role: "chat";
}

interface EmbeddingAiModelConfig extends BaseAiModelConfig {
  provider: "openai";
  role: "embedding";
  dimensions: number;
}

type AiModelConfig = ChatAiModelConfig | EmbeddingAiModelConfig;

const aiProvider = z.enum(["anthropic", "openai"]);
type AiProvider = z.infer<typeof aiProvider>;

const supportedChatModel = z.enum(["claude-haiku-4-5", "claude-sonnet-4-6"]);
export type SupportedChatModel = z.infer<typeof supportedChatModel>;

const supportedEmbeddingModel = z.enum(["text-embedding-3-small"]);
export type SupportedEmbeddingModel = z.infer<typeof supportedEmbeddingModel>;

const supportedAiModel = z.enum([
  ...supportedChatModel.options,
  ...supportedEmbeddingModel.options,
]);
type SupportedAiModel = z.infer<typeof supportedAiModel>;

export const DEFAULT_CHAT_MODEL =
  "claude-haiku-4-5" satisfies SupportedChatModel;
export const COOKBOOK_ESCALATION_MODEL =
  "claude-sonnet-4-6" satisfies SupportedChatModel;
export const DEFAULT_EMBEDDING_MODEL =
  "text-embedding-3-small" satisfies SupportedEmbeddingModel;

const AI_MODEL_REGISTRY = {
  // Provider list prices checked 2026-06-28. Cubby uses this table as the
  // canonical app-side cost source for AI Gateway calls it records.
  "claude-haiku-4-5": {
    provider: "anthropic",
    role: "chat",
    pricing: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 5,
    },
  },
  "claude-sonnet-4-6": {
    provider: "anthropic",
    role: "chat",
    pricing: {
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
    },
  },
  "text-embedding-3-small": {
    provider: "openai",
    role: "embedding",
    dimensions: 1536,
    pricing: {
      inputUsdPerMillion: 0.02,
      outputUsdPerMillion: 0,
    },
  },
} as const satisfies Record<SupportedAiModel, AiModelConfig>;

export type SupportedAiModelRef = {
  [Model in SupportedAiModel]: {
    provider: (typeof AI_MODEL_REGISTRY)[Model]["provider"];
    model: Model;
  };
}[SupportedAiModel];

function finiteTokenCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isSupportedAiModel(model: string): model is SupportedAiModel {
  return supportedAiModel.safeParse(model).success;
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

export function estimateAiUsageCostUsd(
  provider: string,
  model: string,
  usage: AiTokenUsage,
): number | null {
  if (!isSupportedAiModel(model)) return null;
  const config = AI_MODEL_REGISTRY[model];
  if (config.provider !== provider) return null;
  if (usage.inputTokens == null && usage.outputTokens == null) return null;

  const inputCost =
    (finiteTokenCount(usage.inputTokens) / 1_000_000) *
    config.pricing.inputUsdPerMillion;
  const outputCost =
    (finiteTokenCount(usage.outputTokens) / 1_000_000) *
    config.pricing.outputUsdPerMillion;
  return inputCost + outputCost;
}
