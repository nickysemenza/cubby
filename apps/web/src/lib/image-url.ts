import { IMAGE_WIDTHS } from "@cubby/shared/client-constants";

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
//
// Read lazily: server code reaches this module through the `anyOrigin` path in
// runtimes (Playwright fixtures, worker tests) that leave the constant empty.
const bucketHost = (): string => new URL(__R2_PUBLIC_URL__).hostname;

/**
 * Three variants per image, ever (`IMAGE_WIDTHS`). Every request asks for 2×
 * its rendered CSS width (retina is the primary client) and snaps UP to a
 * rung, so a 16px identity mark, a 40px card and a 64px table cell of the same
 * photo are one URL — one CF edge-cache entry, one browser-cache entry, one
 * billed transformation. The native app mints the same URLs
 * (`ImageTransform.swift`, rungs and bucket host generated from the same
 * declarations), so the edge cache is shared across clients too.
 */
export const transformWidth = (renderedWidth: number): number =>
  IMAGE_WIDTHS.find((rung) => rung >= renderedWidth * 2) ?? IMAGE_WIDTHS[2];

const isTransformable = (parsed: URL, anyOrigin: boolean): boolean =>
  (anyOrigin || parsed.hostname === bucketHost()) &&
  !parsed.pathname.startsWith("/cdn-cgi/");

type TransformOptions = {
  /**
   * `jpeg` asks the edge for a JPEG rendition (EXIF/HEIF orientation applied)
   * for consumers that cannot negotiate a format, such as AI providers.
   */
  format?: "auto" | "jpeg";
  /**
   * The server minted the URL from the runtime R2 origin, which can differ
   * from the build-time bucket host this module checks.
   */
  anyOrigin?: boolean;
};

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
  { format = "auto", anyOrigin = false }: TransformOptions = {},
): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!isTransformable(parsed, anyOrigin)) return url;

  // fit=scale-down never upscales a small original; format=auto negotiates
  // AVIF/WebP per the request's Accept header.
  const width = transformWidth(renderedWidth);
  const opts =
    format === "jpeg"
      ? `width=${width},fit=scale-down,format=jpeg`
      : `width=${width},quality=80,format=auto,fit=scale-down`;
  return `${parsed.origin}/cdn-cgi/image/${opts}${parsed.pathname}${parsed.search}`;
};
