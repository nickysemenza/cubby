const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/**
 * Exported for dedupe keys that must fold an unbounded set into one bounded
 * token — a job's `dedupeKey` is indexed, and btree rejects entries past ~2.7 KB.
 */
export async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  return toHex(await crypto.subtle.digest("SHA-256", encoded));
}

export async function embeddingTextHash(opts: {
  entityType: string;
  provider: string;
  model: string;
  dimensions: number;
  text: string;
}): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      entityType: opts.entityType,
      provider: opts.provider,
      model: opts.model,
      dimensions: opts.dimensions,
      text: opts.text,
    }),
  );
}
