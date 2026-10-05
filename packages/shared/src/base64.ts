/** Padded standard base64 (RFC 4648 §4) of raw bytes. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: spreading a photo-sized array into `fromCharCode` overflows the
  // argument limit.
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

/** Unpadded base64url (RFC 4648 §5) of raw bytes or a UTF-8 string. */
export const encodeBase64Url = (value: string | Uint8Array): string =>
  encodeBase64(
    value instanceof Uint8Array ? value : new TextEncoder().encode(value),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

/** The bytes behind a base64url string; padding is optional. */
export const decodeBase64Url = (value: string) =>
  Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );

/** The UTF-8 text behind a base64url string. */
export const decodeBase64UrlText = (value: string): string =>
  new TextDecoder().decode(decodeBase64Url(value));
