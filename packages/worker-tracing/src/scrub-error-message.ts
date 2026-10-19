/**
 * Preserve SQL text, parameters, and upstream bodies; redact only credential-shaped
 * values: labelled secrets, URL userinfo and secret query parameters, and
 * vendor-prefixed keys or JWTs wherever they appear unlabelled.
 */
export function scrubCredentialValues(message: string): string {
  return message
    .replace(
      /\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/giu,
      "$1: [REDACTED]",
    )
    .replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[REDACTED]@")
    .replace(/\b(Bearer|Basic)\s+[\w.+/=-]+/giu, "$1 [REDACTED]")
    .replace(
      /([?&](?:key|sig|(?:[\w.-]*[_-])?(?:api_?key|token|secret|password|signature|credential))=)[^\s&#]*/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:sk-[\w-]{20,}|[sr]k_(?:live|test)_[A-Za-z\d]{16,}|gh[pousr]_[A-Za-z\d]{30,}|github_pat_\w{30,}|AKIA[\dA-Z]{16}|AIza[\w-]{35}|xox[abprs]-[A-Za-z\d-]{10,}|eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]+)/gu,
      "[REDACTED]",
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
