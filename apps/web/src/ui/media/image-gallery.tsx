import {
  preferredImageUrl,
  type ImageRepresentations,
} from "@cubby/schemas/image-summary";
import { useCallback, useEffect, useRef, useState } from "react";

import { PhotoViewer } from "~/features/photos/photo-viewer";
import { cn } from "~/lib/utils";
import { Image } from "~/ui/primitives/image";

interface ImageGalleryProps {
  images: Array<{
    id: string;
    url: string;
    representations?: ImageRepresentations;
    filename: string;
  }>;
  className?: string;
}

/**
 * CSS scroll-snap horizontal gallery with accessible image selectors.
 * Uses IntersectionObserver to track the active image.
 */
export function ImageGallery({ images, className }: ImageGalleryProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const observerRef = useRef<IntersectionObserver | null>(null);

  const setupObserver = useCallback((container: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    if (!container) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (!(entry.target instanceof HTMLElement)) continue;
            const index = Number(entry.target.dataset.index);
            if (!Number.isNaN(index)) {
              setActiveIndex(index);
            }
          }
        }
      },
      {
        root: container,
        threshold: 0.5,
      },
    );

    for (const child of container.children) {
      if (child instanceof HTMLElement && child.dataset.index !== undefined) {
        observerRef.current.observe(child);
      }
    }
  }, []);

  useEffect(() => {
    return () => observerRef.current?.disconnect();
  }, []);

  const scrollTo = useCallback((index: number) => {
    const container = scrollRef.current;
    if (!container) return;
    const child = container.children[index];
    if (!(child instanceof HTMLElement)) return;
    child?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      inline: "start",
      block: "nearest",
    });
  }, []);

  if (images.length === 0) return null;

  return (
    <div className={cn("relative", className)}>
      <div
        ref={(el) => {
          scrollRef.current = el;
          setupObserver(el);
        }}
        className="flex snap-x snap-mandatory scrollbar-none gap-0 overflow-x-auto"
        style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
      >
        {images.map((image, index) => (
          <div
            key={image.id}
            data-index={index}
            className="w-full flex-shrink-0 snap-start"
          >
            <button
              type="button"
              className="relative block h-44 w-full cursor-zoom-in overflow-hidden text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              aria-label={`View ${image.filename}`}
              onClick={() => setViewerIndex(index)}
            >
              <Image
                src={preferredImageUrl(image)}
                alt={image.filename}
                displayWidth={320}
                className="absolute inset-0 h-full w-full bg-muted object-contain"
              />
            </button>
          </div>
        ))}
      </div>

      {/* Image selectors keep the phone touch floor. */}
      {images.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-t border-border bg-card p-1">
          {images.map((image, index) => (
            <button
              key={image.id}
              type="button"
              onClick={() => scrollTo(index)}
              className={cn(
                "flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-xs font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                index === activeIndex
                  ? "bg-primary text-primary-foreground"
                  : "bg-card text-foreground hover:bg-muted",
              )}
              aria-label={`Go to image ${index + 1}`}
              aria-pressed={index === activeIndex}
            >
              {index + 1}
            </button>
          ))}
        </div>
      )}

      <PhotoViewer
        images={images}
        index={viewerIndex}
        onIndexChange={setViewerIndex}
        onOpenChange={(open) => {
          if (!open) setViewerIndex(null);
        }}
        detailLink={(image) => ({ shortcode: image.id })}
      />
    </div>
  );
}
