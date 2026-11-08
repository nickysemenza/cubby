import { ImageBrokenIcon } from "@phosphor-icons/react/dist/csr/ImageBroken";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useState,
} from "react";

import { transformedImageUrl } from "~/lib/image-url";
import { Skeleton } from "~/ui/primitives/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

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
    /** Small content images preview by default; opt out for decorative or nested media. */
    preview?: boolean;
    previewSide?: "top" | "right" | "bottom" | "left";
    previewPositionerClassName?: string;
    /** Optional square thumbnail geometry and navigation. */
    size?: number;
    to?: string;
    params?: Record<string, string>;
    fit?: "cover" | "contain";
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
  preview,
  previewSide = "right",
  previewPositionerClassName,
  size,
  to,
  params,
  fit = "contain",
  ...props
}: ImageProps) {
  displayWidth ??= size;
  style = size == null ? style : { ...style, width: size, height: size };
  className = cn(
    fit === "contain" ? "object-contain" : "object-cover",
    size != null && "absolute inset-0",
    className,
  );
  const hasSrc = typeof src === "string" && src.length > 0;
  const srcUrl = hasSrc ? src : undefined;

  // If a CF transform fails (e.g. transformation outage), retry once with the
  // original URL before giving up to the fallback tile. Failures are keyed to
  // the `src` they describe, not a bare boolean: the node is not remounted
  // when its `src` prop changes (an inline-edited vendor logo), so a boolean
  // set by the previous URL would pin the new one to the fallback forever.
  const [triedOriginalFor, setTriedOriginalFor] = useState<string | null>(null);
  const [erroredFor, setErroredFor] = useState<string | null>(null);
  const triedOriginal = hasSrc && triedOriginalFor === src;
  const errored = hasSrc && erroredFor === src;

  const transformedSrc =
    hasSrc && displayWidth != null
      ? transformedImageUrl(src, displayWidth)
      : srcUrl;
  const transformApplied = hasSrc && transformedSrc !== src;
  const useTransform = transformApplied && !triedOriginal;

  // No srcSet: the helper already requests 2× the rendered width, so every
  // device pixel ratio fetches the same URL and shares one cache entry.
  const effectiveSrc = useTransform ? transformedSrc : srcUrl;

  // Skip the placeholder entirely for images already loaded this session.
  // Keyed on the final (transformed) URL, so two placements that snap to the
  // same rung share the "already seen it" decision.
  const [isLoading, setIsLoading] = useState(
    () => !(effectiveSrc != null && loadedSrcs.has(effectiveSrc)),
  );

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
        className={cn(
          "flex items-center justify-center bg-muted/30",
          className,
        )}
        style={style}
        role={accessibleAlt ? "img" : undefined}
        aria-label={accessibleAlt}
        aria-hidden={accessibleAlt ? undefined : true}
      >
        {fallback ?? (
          <ImageBrokenIcon
            className="h-1/3 max-h-5 w-1/3 max-w-5 text-muted-foreground/40"
            aria-hidden
          />
        )}
      </div>
    );
  }

  const image = (
    <img
      ref={handleRef}
      src={effectiveSrc}
      alt={alt}
      loading="lazy"
      decoding="async"
      onLoad={markLoaded}
      onError={() => {
        if (useTransform) {
          setTriedOriginalFor(srcUrl ?? null);
          return;
        }
        setErroredFor(srcUrl ?? null);
        setIsLoading(false);
      }}
      className={cn(
        className,
        "transition-opacity duration-(--brand-motion-fast) ease-cozy",
        isLoading ? "opacity-0" : "opacity-100",
      )}
      style={style}
      {...props}
    />
  );
  const loading = isLoading ? (
    <div
      className={cn("flex items-center justify-center bg-muted/25", className)}
      style={style}
      aria-hidden
    >
      {loadingFallback ?? <Skeleton className="size-full rounded-none" />}
    </div>
  ) : null;
  const squareStyle = size == null ? undefined : { width: size, height: size };
  const trigger = to ? (
    <Link
      to={to}
      params={params}
      className="relative inline-flex shrink-0"
      style={squareStyle}
    >
      {loading}
      {image}
    </Link>
  ) : size != null ? (
    <span className="relative inline-flex shrink-0" style={squareStyle}>
      {loading}
      {image}
    </span>
  ) : (
    image
  );
  // The popup is already 256px; larger images gain nothing from a smaller copy.
  const showPreview =
    preview ?? (alt !== "" && displayWidth != null && displayWidth < 256);
  return (
    <>
      {!to && size == null ? loading : null}
      {showPreview ? (
        <Tooltip lazy>
          <TooltipTrigger render={trigger} />
          <ImagePreviewPopup
            src={srcUrl ?? ""}
            alt={alt ?? ""}
            side={previewSide}
            positionerClassName={previewPositionerClassName}
          />
        </Tooltip>
      ) : (
        trigger
      )}
    </>
  );
}

export function ImagePreviewPopup({
  src,
  alt,
  side = "right",
  positionerClassName,
}: {
  src: string;
  alt: string;
  side?: "top" | "right" | "bottom" | "left";
  positionerClassName?: string;
}) {
  return (
    <TooltipContent
      side={side}
      positionerClassName={positionerClassName}
      // pointer-events-none: the popup is purely a look at the image, and it
      // is portalled over whatever surface the thumbnail sits in — on the
      // arrange board that surface is a drag-and-drop hit-test area, and on a
      // combobox it is the option list.
      className="pointer-events-none max-w-none overflow-hidden rounded-none border border-[var(--border)] bg-popover p-0"
    >
      <div className="relative" style={{ width: 256, height: 256 }}>
        <Image
          preview={false}
          src={src}
          alt={alt}
          displayWidth={256}
          className="absolute inset-0 h-full w-full bg-card object-contain"
        />
      </div>
    </TooltipContent>
  );
}
