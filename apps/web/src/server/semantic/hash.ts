const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** Lowercase hex SHA-256 of a UTF-8 string or raw bytes. */
export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes =
    value instanceof Uint8Array
      ? new Uint8Array(value)
      : new TextEncoder().encode(value);
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
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
