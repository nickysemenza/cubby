import { cn } from "~/lib/utils";
import { type ReactNode } from "react";

interface ProseProps {
  children: ReactNode;
  className?: string;
}

/**
 * Styled wrapper for documentation prose content.
 * Applies consistent typography styles to headings, paragraphs, lists, and links.
 */
export function Prose({ children, className }: ProseProps) {
  return (
    <div
      className={cn(
        "max-w-none",
        // Headings
        "[&_h1]:mb-4 [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:tracking-tight",
        "[&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-2xl [&_h2]:font-semibold",
        "[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-xl [&_h3]:font-medium",
        // Text
        "[&_p]:text-muted-foreground [&_p]:mb-4 [&_p]:leading-7",
        "[&_strong]:text-foreground [&_strong]:font-medium",
        // Lists
        "[&_ul]:mb-4 [&_ul]:ml-6 [&_ul]:list-disc [&_ul]:space-y-1",
        "[&_ol]:mb-4 [&_ol]:ml-6 [&_ol]:list-decimal [&_ol]:space-y-1",
        "[&_li]:text-muted-foreground",
        // Links
        "[&_a]:text-primary hover:[&_a]:text-primary/80 [&_a]:underline [&_a]:underline-offset-4",
        // Code
        "[&_code]:bg-muted [&_code]:rounded [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}
