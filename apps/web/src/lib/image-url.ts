// Cloudflare Image Transformations URL rewriting (client-safe, pure).
//
// Stored image URLs are absolute R2 public URLs on our bucket host. Cloudflare's
// edge resizes/reformats images requested via the `/cdn-cgi/image/<opts>/<path>`
// prefix on the same zone — so we rewrite at render time only, leaving the DB and
// API responses untouched. The transform is done by CF's edge, not our worker,
// so this works identically in dev (vite) and prod.
//
// Vite injects the public origin from wrangler.jsonc for client and SSR builds.
// Keeping that deployment config authoritative prevents stored object keys from
// acquiring a second, client-only hostname setting.
const BUCKET_ORIGIN = __R2_PUBLIC_URL__;
const BUCKET_HOST = new URL(BUCKET_ORIGIN).hostname;

/**
 * Three variants per image, ever. Every request asks for 2× its rendered CSS
 * width (retina is the primary client) and snaps UP to a rung, so a 16px
 * identity mark, a 40px card and a 64px table cell of the same photo are one
 * URL — one CF edge-cache entry, one browser-cache entry, one billed
 * transformation. The native app mints the same URLs (`ImageTransform.swift`),
 * so the edge cache is shared across clients too.
 */
export const IMAGE_WIDTHS = [128, 640, 2048] as const;

/** Transform width for a rendered CSS width: 2× for retina, snapped up. */
export const transformWidth = (renderedWidth: number): number =>
  IMAGE_WIDTHS.find((rung) => rung >= renderedWidth * 2) ?? 2048;

const isTransformable = (parsed: URL): boolean =>
  parsed.hostname === BUCKET_HOST && !parsed.pathname.startsWith("/cdn-cgi/");

/**
 * Rewrite an R2 image URL to request a width-bounded, auto-format variant via
 * Cloudflare Image Transformations. Returns the input unchanged for non-bucket
 * URLs, already-transformed URLs, or anything that doesn't parse as a URL.
 *
 * @param url           absolute image URL (typically `image.url` from the API)
 * @param renderedWidth the box's CSS width — declare what is rendered, never a
 *                      rung; snapping is this helper's job (helper does not
 *                      upscale)
 */
export const transformedImageUrl = (
  url: string,
  renderedWidth: number,
): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!isTransformable(parsed)) return url;

  // fit=scale-down never upscales a small original; format=auto negotiates
  // AVIF/WebP per the request's Accept header.
  const opts = `width=${transformWidth(renderedWidth)},quality=80,format=auto,fit=scale-down`;
  return `${parsed.origin}/cdn-cgi/image/${opts}${parsed.pathname}${parsed.search}`;
};
