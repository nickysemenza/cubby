import { useState, type ComponentProps } from "react";
import { cn } from "~/lib/utils";

export type ImageProps = Omit<
  ComponentProps<"img">,
  "loading" | "onError" | "onLoad"
>;

/**
 * Lazy-loaded image component with native browser lazy loading.
 * Drop-in replacement for next/image (without optimization).
 */
export function Image({ src, alt, className, style, ...props }: ImageProps) {
  const [isLoading, setIsLoading] = useState(true);

  return (
    <>
      {isLoading && (
        <div className={cn("animate-pulse bg-muted", className)} style={style} />
      )}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setIsLoading(false)}
        onError={() => setIsLoading(false)}
        className={cn(className, isLoading && "invisible")}
        style={style}
        {...props}
      />
    </>
  );
}
