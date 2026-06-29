import {
  DEFAULT_EMBEDDING_MODEL,
  getEmbeddingModelConfig,
  type SupportedEmbeddingModel,
} from "~/server/ai/models";

export interface SemanticEmbeddingConfig {
  provider: "openai";
  model: SupportedEmbeddingModel;
  dimensions: number;
}

export function getSemanticEmbeddingConfig(): SemanticEmbeddingConfig {
  const model = DEFAULT_EMBEDDING_MODEL;
  const config = getEmbeddingModelConfig(model);
  return {
    provider: config.provider,
    model,
    dimensions: config.dimensions,
  };
}
