const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

type Digestible = string | ArrayBuffer | Uint8Array;

const sha256Bytes = async (value: Digestible): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      value instanceof ArrayBuffer || value instanceof Uint8Array
        ? new Uint8Array(value)
        : new TextEncoder().encode(value),
    ),
  );

/** Lowercase hex SHA-256 of a UTF-8 string or raw bytes. */
export async function sha256Hex(value: Digestible): Promise<string> {
  return toHex(await sha256Bytes(value));
}

/**
 * A stable name-based UUID (version 5 layout) from the first 16 bytes of the
 * string's SHA-256, so a retried write lands on the same row id.
 */
export async function sha256Uuid(value: string): Promise<string> {
  const bytes = (await sha256Bytes(value)).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
