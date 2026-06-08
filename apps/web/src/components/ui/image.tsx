import { useCallback, useState, type ComponentProps } from "react";
import { cn } from "~/lib/utils";

export type ImageProps = Omit<
  ComponentProps<"img">,
  "loading" | "onError" | "onLoad" | "ref"
>;

// URLs that have successfully loaded this session. Virtualized tables
// unmount/remount rows while scrolling; without remembering, every remount
// restarts loading state and flashes the placeholder even though the browser
// already has the image. img.complete only catches the case where the decode is
// synchronously ready at mount — under fast scrolling it often isn't, so we also
// track loaded URLs to make the "already seen it" decision timing-independent.
const loadedSrcs = new Set<string>();

/**
 * Lazy-loaded image component with native browser lazy loading.
 * Drop-in replacement for next/image (without optimization).
 */
export function Image({ src, alt, className, style, ...props }: ImageProps) {
  // Skip the placeholder entirely for images already loaded this session.
  const [isLoading, setIsLoading] = useState(
    () => !(typeof src === "string" && loadedSrcs.has(src)),
  );

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

  return (
    <>
      {isLoading && (
        <div className={cn("skeleton-shimmer", className)} style={style} />
      )}
      <img
        ref={handleRef}
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={markLoaded}
        onError={() => setIsLoading(false)}
        className={cn(className, isLoading && "invisible")}
        style={style}
        {...props}
      />
    </>
  );
}
