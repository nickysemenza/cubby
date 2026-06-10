import { ImageOff } from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import { cn } from "~/lib/utils";

export type ImageProps = Omit<
  ComponentProps<"img">,
  "loading" | "onError" | "onLoad" | "ref"
> & {
  /**
   * Rendered in place of the image when the src is missing or fails to load.
   * Should fill its box (h-full w-full). Defaults to a quiet muted icon tile.
   */
  fallback?: ReactNode;
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
  ...props
}: ImageProps) {
  const hasSrc = typeof src === "string" && src.length > 0;

  // Skip the placeholder entirely for images already loaded this session.
  const [isLoading, setIsLoading] = useState(
    () => !(hasSrc && loadedSrcs.has(src as string)),
  );
  const [errored, setErrored] = useState(false);

  const markLoaded = useCallback(() => {
    if (typeof src === "string") loadedSrcs.add(src);
    setIsLoading(false);
  }, [src]);

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
    return (
      <div
        className={cn("flex items-center justify-center bg-muted/30", className)}
        style={style}
        aria-label={typeof alt === "string" ? alt : undefined}
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
          className={cn("bg-muted/25", className)}
          style={style}
          aria-hidden
        />
      )}
      <img
        ref={handleRef}
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={markLoaded}
        onError={() => {
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
