/** Preserve SQL text, parameters, and upstream bodies; redact only credential-shaped values. */
export function scrubCredentialValues(message: string): string {
  return message
    .replace(
      /\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/giu,
      "$1: [REDACTED]",
    )
    .replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[REDACTED]@")
    .replace(/\b(Bearer|Basic)\s+[\w.+/=-]+/giu, "$1 [REDACTED]")
    .replace(
      /([?&](?:key|api_?key|token|access_token|refresh_token|password|secret|signature|x-amz-signature)=)[^\s&#]*/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\b((?:password|passwd|secret|api_?key|token|access_token|refresh_token|authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/giu,
      "$1[REDACTED]",
    );
}

/** User-facing error causes retain the existing 2000-character bound. */
export function scrubErrorMessage(message: string): string {
  return scrubCredentialValues(message).slice(0, 2000);
}
