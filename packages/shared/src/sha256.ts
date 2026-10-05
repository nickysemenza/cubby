const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256 = async (value: string | ArrayBuffer | Uint8Array) =>
  new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      value instanceof ArrayBuffer || value instanceof Uint8Array
        ? new Uint8Array(value)
        : new TextEncoder().encode(value),
    ),
  );

/** Lowercase hex SHA-256 of a UTF-8 string or raw bytes, via WebCrypto. */
export async function sha256Hex(
  value: string | ArrayBuffer | Uint8Array,
): Promise<string> {
  return toHex(await sha256(value));
}

/**
 * Deterministic UUID from the first 16 bytes of `value`'s SHA-256, with the
 * version-5 and RFC 4122 variant bits set. Not `uuid`'s v5 (that is SHA-1 over
 * a namespace): ids already stored were minted by this exact rule.
 */
export async function sha256Uuid(value: string): Promise<string> {
  const bytes = (await sha256(value)).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
