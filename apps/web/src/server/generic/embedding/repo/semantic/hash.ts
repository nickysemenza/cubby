import { prepareEmbeddingText } from "@cubby/shared/ai/embedding-input";
import type { SupportedEmbeddingModel } from "@cubby/shared/ai/models";
import { sha256Hex } from "@cubby/shared/sha256";

export async function embeddingTextHash(opts: {
  entityKind: string;
  provider: string;
  model: SupportedEmbeddingModel;
  dimensions: number;
  text: string;
}): Promise<string> {
  const input = await prepareEmbeddingText(opts.text, opts.model);
  return sha256Hex(
    JSON.stringify({
      entityKind: opts.entityKind,
      provider: opts.provider,
      model: opts.model,
      dimensions: opts.dimensions,
      text: opts.text,
      // Source freshness still compares full semantic text. Distinct omitted tails
      // need distinct artifacts, while the model cache can reuse their prefix vector.
      ...(input === opts.text ? {} : { input }),
    }),
  );
}
