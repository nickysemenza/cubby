const VALUE = String.raw`[^\s,;}&"'<>]`;
const PAGINATION_TOKEN = String.raw`[\w-]*(?:page|next|prev|previous|continuation|pagination|sync|cursor)[_-]?token`;

/**
 * Preserve SQL text, parameters, and upstream bodies; redact only credential-shaped
 * values: labelled secrets, URL userinfo and secret query parameters, and
 * vendor-prefixed keys or JWTs wherever they appear unlabelled. Labels alone are
 * not enough: transcripts carry product names and prose ("Basic Tee",
 * "Cookie: Chocolate Chip"), so each value must also look like a credential.
 */
/** `Basic` is prose ("Basic Tee") unless its value decodes to `user:password`. */
function isBasicCredential(value: string): boolean {
  try {
    return atob(value).includes(":");
  } catch {
    return false;
  }
}

export function scrubCredentialValues(message: string): string {
  return (
    message
      .replace(
        new RegExp(
          String.raw`(^|[\s"'{,])(authorization["']?\s*:\s*["']?)(?:[A-Za-z\d-]+\s+[^\s"']+|[\w.+/=~-]{16,})[^\r\n"']*`,
          "giu",
        ),
        "$1$2[REDACTED]",
      )
      .replace(
        /(^|[\s"'{,])((?:set-)?cookie["']?\s*:\s*["']?)[^\s=;"']+=[^\r\n"']*/giu,
        "$1$2[REDACTED]",
      )
      // Bounded scheme: an unbounded `[a-z\d+.-]*` before `://` is quadratic on long hyphen runs.
      .replace(
        /(?<![\w.-])([a-z][a-z\d+.-]{0,30}:\/\/)[^\s/@]+:[^\s/@]+@/giu,
        "$1[REDACTED]@",
      )
      .replace(/\b(Bearer)\s+[\w.+/=-]{16,}/giu, "$1 [REDACTED]")
      .replace(
        /\b(Basic)\s+([A-Za-z\d+/]{4,}={0,2})(?![\w-])/giu,
        (match, scheme: string, value: string) =>
          isBasicCredential(value) ? `${scheme} [REDACTED]` : match,
      )
      .replace(
        new RegExp(
          String.raw`([?&](?!${PAGINATION_TOKEN}=)(?:key|sig|(?:[\w.-]*[_-])?(?:api_?key|token|secret|password|signature|credential))=)[^\s&#"'<>]*`,
          "giu",
        ),
        "$1[REDACTED]",
      )
      .replace(
        /\b(?:sk-(?:[A-Za-z\d]{20,}|(?:ant|proj)-[\w-]{20,})|[sr]k_(?:live|test)_[A-Za-z\d]{16,}|gh[pousr]_[A-Za-z\d]{30,}|github_pat_\w{30,}|AKIA[\dA-Z]{16}(?![\w-])|AIza[\w-]{35}(?![\w-])|xox[abprs]-[A-Za-z\d-]{10,}|eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]+)/gu,
        "[REDACTED]",
      )
      // A `label: value` must be token-shaped (prose such as "Secret: order" is
      // not), except passwords, which are often plain words; `label=value` and
      // quoted values are assignments. SQL placeholders stay.
      .replace(
        new RegExp(
          String.raw`(?<![\w-])((?:password|passwd|secret|api_?key|token|access_token|refresh_token|authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?!\$\d+\b)(?:(["'])(?:(?!\2)[^\r\n])*\2|(?<==\s*)${VALUE}+|(?<=pass(?:word|wd)["']?\s*:\s*)${VALUE}+|(?=${VALUE}*[\d_.+/=-])${VALUE}{6,})`,
          "giu",
        ),
        (_match, label: string, quote = "") =>
          `${label}${quote}[REDACTED]${quote}`,
      )
  );
}

/** User-facing error causes retain the existing 2000-character bound. */
export function scrubErrorMessage(message: string): string {
  return scrubCredentialValues(message).slice(0, 2000);
}
