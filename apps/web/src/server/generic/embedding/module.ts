import { z } from "zod";

import { defineAsk, defineModule, definePass } from "~/server/kernel/api";

import { getSemanticEmbeddingConfig } from "./service/semantic/config";

const config = getSemanticEmbeddingConfig();
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
    const { embedTexts } = await import("./service/semantic/embeddings");
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
  asks: [embeddingAsk],
  passes: [vectorizeSync],
});
