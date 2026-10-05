import { sha256Hex } from "@cubby/shared/sha256";

export async function embeddingTextHash(opts: {
  entityKind: string;
  provider: string;
  model: string;
  dimensions: number;
  text: string;
}): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      entityKind: opts.entityKind,
      provider: opts.provider,
      model: opts.model,
      dimensions: opts.dimensions,
      text: opts.text,
    }),
  );
}
