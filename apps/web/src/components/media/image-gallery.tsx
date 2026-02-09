import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";

interface ImageGalleryProps {
  images: Array<{ id: string; url: string; filename: string }>;
  className?: string;
}

/**
 * CSS scroll-snap horizontal gallery with pagination dots.
 * Uses IntersectionObserver to track the active image.
 */
export function ImageGallery({ images, className }: ImageGalleryProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

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
            const index = Number((entry.target as HTMLElement).dataset.index);
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
    const child = container.children[index] as HTMLElement | undefined;
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
          (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current =
            el;
          setupObserver(el);
        }}
        className="scrollbar-none flex snap-x snap-mandatory gap-0 overflow-x-auto"
        style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
      >
        {images.map((image, index) => (
          <div
            key={image.id}
            data-index={index}
            className="w-full flex-shrink-0 snap-start"
          >
            <img
              src={image.url}
              alt={image.filename}
              className="aspect-[4/3] w-full object-cover"
              loading={index === 0 ? "eager" : "lazy"}
            />
          </div>
        ))}
      </div>

      {/* Pagination dots */}
      {images.length > 1 && (
        <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1.5">
          {images.map((image, index) => (
            <button
              key={image.id}
              type="button"
              onClick={() => scrollTo(index)}
              className={cn(
                "h-1.5 rounded-full transition-all duration-200",
                index === activeIndex ? "w-4 bg-white" : "w-1.5 bg-white/50",
              )}
              aria-label={`Go to image ${index + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
