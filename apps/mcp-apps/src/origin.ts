/**
 * How an app learns the origin it should deep-link back to.
 *
 * A sandboxed iframe can't know what origin its MCP server is served from, and
 * baking it into the bundle would make the build environment-specific. So each
 * app ships a `<meta name="cubby-origin">` placeholder and whoever serves the
 * resource rewrites it.
 *
 * A leaf module on purpose. Both the apps and `bundles.ts` need this, but
 * `bundles.ts` glob-imports every built bundle; if an app reached it through
 * there, each build would inline the *previous* build's output into itself.
 * (It did — the second bundle came out at double size.) Nothing here may import
 * anything else in this package.
 */

/**
 * Rewrite the `__CUBBY_ORIGIN__` placeholder in a built bundle.
 *
 * Scoped to the meta tag rather than a blanket `replaceAll`: the placeholder
 * string also appears in the app's own inlined JavaScript (it's a constant in
 * this very module), and a document-wide replace silently rewrites that too —
 * which broke every deep link, because the app's comparison against the
 * placeholder then matched the substituted origin.
 */
export function withCubbyOrigin(html: string, origin: string): string {
  return html.replace(
    /(<meta\s+name="cubby-origin"\s+content=")[^"]*(")/,
    `$1${origin}$2`,
  );
}

/**
 * The origin to deep-link to, or `null` when the placeholder was never
 * substituted (degrade to no links rather than a page of broken ones).
 *
 * Validates the shape rather than comparing against the placeholder literal —
 * an app can't trust its own copy of that string to survive substitution, which
 * is exactly the bug above.
 */
export function readCubbyOrigin(doc: Document): string | null {
  const value = doc.querySelector<HTMLMetaElement>(
    'meta[name="cubby-origin"]',
  )?.content;
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
