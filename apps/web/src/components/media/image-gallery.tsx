import {
  preferredImageUrl,
  type ImageRepresentations,
} from "@cubby/schemas/image-summary";
import { useCallback, useEffect, useRef, useState } from "react";

import { PhotoViewer } from "~/app/_components/photos/photo-viewer";
import { transformedImageUrl } from "~/lib/image-url";
import { cn } from "~/lib/utils";

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
 * CSS scroll-snap horizontal gallery with pagination dots.
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
      behavior: "smooth",
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
              className="block w-full cursor-zoom-in text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              aria-label={`View ${image.filename}`}
              onClick={() => setViewerIndex(index)}
            >
              <img
                src={transformedImageUrl(preferredImageUrl(image), 800)}
                alt={image.filename}
                className="aspect-video w-full bg-card object-contain md:aspect-[4/3]"
                loading={index === 0 ? "eager" : "lazy"}
              />
            </button>
          </div>
        ))}
      </div>

      {/* Pagination dots */}
      {images.length > 1 && (
        <div className="absolute bottom-8 left-1/2 flex -translate-x-1/2 gap-2">
          {images.map((image, index) => (
            <button
              key={image.id}
              type="button"
              onClick={() => scrollTo(index)}
              className={cn(
                "h-1.5 rounded-full transition-all duration-150",
                index === activeIndex ? "w-4 bg-white" : "w-1.5 bg-white/50",
              )}
              aria-label={`Go to image ${index + 1}`}
            />
          ))}
        </div>
      )}

      {/* Figure caption — the gallery reads as a numbered plate */}
      <div className="border-b border-border bg-card px-2 py-1 eyebrow sm:px-4 sm:py-2">
        Fig. {String(activeIndex + 1).padStart(2, "0")} / {images.length}
      </div>
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
