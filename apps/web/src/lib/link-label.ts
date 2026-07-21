// Pure, alias-free so the vitest `unit` project can import it (it can't import
// `~/...` .tsx). Mirrors the www-stripping / try-catch shape of `sourceHost` in
// app/_components/recipe/recipe-source.tsx.

/** Normalize for self-link comparison: drop scheme, `www.`, and a trailing `/`. */
function normalizeForCompare(url: string): string {
  return url
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "");
}

/** Truncate a URL path to keep link labels compact. */
function truncatePath(path: string, max = 24): string {
  return path.length > max ? `${path.slice(0, max - 1)}…` : path;
}

/**
 * Short display label for a link whose visible text is just its own URL — the
 * `[https://x/y](https://x/y)` shape the Notion import left in project notes.
 *
 * Returns `null` when the text is *not* effectively the same URL as the href
 * (comparison ignores scheme, `www.`, and a trailing slash) — the caller should
 * then render the original text unchanged. On a non-self-link or an unparseable
 * href, also returns `null`.
 *
 * Otherwise returns `host` (www-stripped) + truncated path, e.g.
 * `amazon.com/dp/B00JWFIKOC`.
 */
export function selfLinkLabel(href: string, text: string): string | null {
  if (normalizeForCompare(href) !== normalizeForCompare(text)) return null;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  const path = truncatePath(
    `${parsed.pathname}${parsed.search}`.replace(/\/$/, ""),
  );
  return `${host}${path}`;
}
