import { z } from "zod";

import { SEMANTIC_QUERY_FEATURE } from "~/server/ai/policy/features";
import { defineAsk, defineModule, definePass } from "~/server/kernel/api";
import { WorkPausedError } from "~/server/kernel/work-errors";

import { getSemanticEmbeddingConfig } from "./service/semantic/config";

const config = getSemanticEmbeddingConfig();
export const queryEmbeddingAsk = defineAsk({
  feature: SEMANTIC_QUERY_FEATURE.feature,
  producer: "embedding",
  promptVersion: SEMANTIC_QUERY_FEATURE.promptVersion,
  input: z.object({
    text: z
      .string()
      .trim()
      .min(1)
      .transform((text) => text.replace(/\s+/g, " ").toLowerCase()),
    interactive: z.boolean().default(false),
  }),
  output: z.array(z.number().finite()).length(config.dimensions),
  policy: {
    model: config.model,
    parameters: { dimensions: config.dimensions },
    outputRevision: "1",
  },
  label: "search candidates",
  async admit() {
    const { semanticEmbeddingsConfigured } =
      await import("~/server/generic/embedding/service/semantic/embeddings");
    if (!semanticEmbeddingsConfigured())
      throw new WorkPausedError("Semantic search is not configured");
  },
  async produce(input, { db, runId }) {
    const { embedTexts } =
      await import("~/server/generic/embedding/service/semantic/embeddings");
    const [output] = await embedTexts([input.text], {
      db,
      config,
      feature: SEMANTIC_QUERY_FEATURE.feature,
      operation: "queryEmbedding",
      interactive: input.interactive,
      ...(runId
        ? {
            runId: (
              await import("@cubby/schemas/identifiers")
            ).runEntityId.parse(runId),
          }
        : {}),
    });
    if (!output) throw new Error("Embedding provider returned no query vector");
    return { output, model: config.model };
  },
});

export const embeddingAsk = defineAsk({
  feature: "entity.embedding",
  producer: "embedding",
  promptVersion: "1",
  maxAttempts: 100,
  input: z.object({
    entityId: z.uuid(),
    entityKind: z.string(),
    sourceHash: z.string(),
    text: z.string(),
  }),
  output: z.array(z.number()).length(config.dimensions),
  policy: {
    model: config.model,
    parameters: { dimensions: config.dimensions },
    outputRevision: "1",
  },
  label: "a search vector",
  async produce(input, { db }) {
    const { embedTexts } =
      await import("~/server/generic/embedding/service/semantic/embeddings");
    const [output] = await embedTexts([input.text], {
      db,
      feature: "entity_embedding",
      config,
    });
    if (!output) throw new Error("Embedding provider returned no vector");
    return { output, model: config.model };
  },
});

export const vectorizeSync = definePass({
  name: "vectorize.sync",
  async run(db, cursor, claim) {
    try {
      return await (
        await import("~/server/generic/embedding/service/vectorize-sync")
      ).syncVectorize(db, cursor, claim);
    } catch (error) {
      const { AskUnknownError, AskAbandonedError } =
        await import("~/server/kernel/api");
      if (error instanceof AskAbandonedError) return { cursor, done: true };
      if (error instanceof AskUnknownError)
        return {
          cursor,
          done: false,
          availableAt: new Date(Date.now() + 21600000),
          waitCause: "provider_capacity",
        };
      throw error;
    }
  },
});

export const embeddingKernelModule = defineModule({
  name: "embedding",
  asks: [embeddingAsk, queryEmbeddingAsk],
  passes: [vectorizeSync],
});
