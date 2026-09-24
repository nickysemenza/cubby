import { ImageBrokenIcon as ImageOff } from "@phosphor-icons/react/dist/csr/ImageBroken";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import { transformedImageUrl } from "~/lib/image-url";
import { cn } from "~/lib/utils";

export type ImageProps = Omit<
  ComponentProps<"img">,
  "loading" | "onError" | "onLoad" | "ref"
> &
  (
    | { displayWidth: number; unoptimized?: never }
    | { displayWidth?: never; unoptimized: true }
  ) & {
  /**
   * Rendered in place of the image when the src is missing or fails to load.
   * Should fill its box (h-full w-full). Defaults to a quiet muted icon tile.
   */
  fallback?: ReactNode;
  /**
   * Optional content shown in the reserved image box until decoding finishes.
   * The default remains the quiet paper tint; identity marks supply their
   * semantic entity icon so an image never creates a blank intermediate state.
   */
  loadingFallback?: ReactNode;
  /** Skip transformations for a known non-bucket URL or an intentional test. */
  unoptimized?: true;
};

// URLs that have successfully loaded this session. Virtualized tables
// unmount/remount rows while scrolling; without remembering, every remount
// restarts loading state and flashes the placeholder even though the browser
// already has the image. img.complete only catches the case where the decode is
// synchronously ready at mount — under fast scrolling it often isn't, so we also
// track loaded URLs to make the "already seen it" decision timing-independent.
const loadedSrcs = new Set<string>();

/**
 * Lazy-loaded image with a calm fade-in and a graceful fallback.
 *
 * - Reserves its box via the caller's className (no layout shift).
 * - Fades in over a quiet muted placeholder once decoded — no pop, no spinner.
 *   Images already seen this session (or browser-cached) skip the fade.
 * - On a missing/failed src, renders `fallback` (or a muted icon tile) instead
 *   of the browser's broken-image glyph.
 */
export function Image({
  src,
  alt,
  className,
  style,
  fallback,
  loadingFallback,
  displayWidth,
  unoptimized: _unoptimized,
  ...props
}: ImageProps) {
  const hasSrc = typeof src === "string" && src.length > 0;

  // If a CF transform fails (e.g. transformation outage), retry once with the
  // original URL before giving up to the fallback tile.
  const [triedOriginal, setTriedOriginal] = useState(false);

  const transformedSrc =
    hasSrc && displayWidth != null
      ? transformedImageUrl(src as string, displayWidth)
      : (src as string | undefined);
  const transformApplied = hasSrc && transformedSrc !== src;
  const useTransform = transformApplied && !triedOriginal;

  // No srcSet: the helper already requests 2× the rendered width, so every
  // device pixel ratio fetches the same URL and shares one cache entry.
  const effectiveSrc = useTransform
    ? transformedSrc
    : (src as string | undefined);

  // Skip the placeholder entirely for images already loaded this session.
  // Keyed on the final (transformed) URL, so two placements that snap to the
  // same rung share the "already seen it" decision.
  const [isLoading, setIsLoading] = useState(
    () => !(effectiveSrc != null && loadedSrcs.has(effectiveSrc)),
  );
  const [errored, setErrored] = useState(false);

  const markLoaded = useCallback(() => {
    if (effectiveSrc != null) loadedSrcs.add(effectiveSrc);
    setIsLoading(false);
  }, [effectiveSrc]);

  // Belt-and-suspenders for images the browser cached on a prior page load (not
  // yet in loadedSrcs): if it's already complete at mount, skip the placeholder
  // before paint. Ref callbacks run in the layout phase, before the browser
  // paints, so this never flashes.
  const handleRef = useCallback(
    (node: HTMLImageElement | null) => {
      if (node?.complete && node.naturalWidth > 0) markLoaded();
    },
    [markLoaded],
  );

  if (!hasSrc || errored) {
    const accessibleAlt =
      typeof alt === "string" && alt.length > 0 ? alt : undefined;
    return (
      <div
        className={cn("flex items-center justify-center bg-muted/30", className)}
        style={style}
        role={accessibleAlt ? "img" : undefined}
        aria-label={accessibleAlt}
        aria-hidden={accessibleAlt ? undefined : true}
      >
        {fallback ?? (
          <ImageOff
            className="h-1/3 max-h-5 w-1/3 max-w-5 text-muted-foreground/40"
            aria-hidden
          />
        )}
      </div>
    );
  }

  return (
    <>
      {isLoading && (
        <div
          className={cn(
            "flex items-center justify-center bg-muted/25",
            className,
          )}
          style={style}
          aria-hidden
        >
          {loadingFallback}
        </div>
      )}
      <img
        ref={handleRef}
        src={effectiveSrc}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={markLoaded}
        onError={() => {
          // First failure of a transformed URL → fall back to the original.
          if (useTransform) {
            setTriedOriginal(true);
            return;
          }
          setErrored(true);
          setIsLoading(false);
        }}
        className={cn(
          className,
          "transition-opacity duration-500 ease-out",
          isLoading ? "opacity-0" : "opacity-100",
        )}
        style={style}
        {...props}
      />
    </>
  );
}
