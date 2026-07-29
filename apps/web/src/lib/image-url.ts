// Cloudflare Image Transformations URL rewriting (client-safe, pure).
//
// Stored image URLs are absolute R2 public URLs on our bucket host. Cloudflare's
// edge resizes/reformats images requested via the `/cdn-cgi/image/<opts>/<path>`
// prefix on the same zone — so we rewrite at render time only, leaving the DB and
// API responses untouched. The transform is done by CF's edge, not our worker,
// so this works identically in dev (vite) and prod.
//
// Host is hardcoded (not read from env) because this runs on the client where
// R2_PUBLIC_URL isn't available, and CF transforms only work on this zone anyway.
const BUCKET_ORIGIN = "https://foobucket.nicky.fun";
const BUCKET_HOST = new URL(BUCKET_ORIGIN).hostname;

/** Build an absolute public-bucket URL from a slash-tolerant object key. */
export const publicBucketUrl = (key: string): string =>
  `${BUCKET_ORIGIN}/${key.replace(/^\/+/, "")}`;

const isTransformable = (parsed: URL): boolean =>
  parsed.hostname === BUCKET_HOST && !parsed.pathname.startsWith("/cdn-cgi/");

/**
 * Rewrite an R2 image URL to request a width-bounded, auto-format variant via
 * Cloudflare Image Transformations. Returns the input unchanged for non-bucket
 * URLs, already-transformed URLs, or anything that doesn't parse as a URL.
 *
 * @param url   absolute image URL (typically `image.url` from the API)
 * @param width target display width in CSS pixels (helper does not upscale)
 */
export const transformedImageUrl = (url: string, width: number): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!isTransformable(parsed)) return url;

  // fit=scale-down never upscales a small original; format=auto negotiates
  // AVIF/WebP per the request's Accept header.
  const opts = `width=${width},quality=80,format=auto,fit=scale-down`;
  return `${parsed.origin}/cdn-cgi/image/${opts}${parsed.pathname}${parsed.search}`;
};

/**
 * Build a `srcSet` value offering 1x and 2x variants for retina displays
 * (the iOS PWA is the primary client). Returns undefined when the URL isn't
 * transformable, so callers can spread it without emitting a useless srcSet.
 */
export const transformedSrcSet = (
  url: string,
  width: number,
): string | undefined => {
  const one = transformedImageUrl(url, width);
  if (one === url) return undefined; // not transformable
  const two = transformedImageUrl(url, width * 2);
  return `${one} 1x, ${two} 2x`;
};
