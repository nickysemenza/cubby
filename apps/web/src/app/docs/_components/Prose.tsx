import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

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
        "[&_h1]:mb-4 [&_h1]:font-bold [&_h1]:text-3xl [&_h1]:tracking-tight",
        "[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:font-semibold [&_h2]:text-2xl",
        "[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:font-medium [&_h3]:text-xl",
        // Text
        "[&_p]:mb-4 [&_p]:text-muted-foreground [&_p]:leading-7",
        "[&_strong]:font-medium [&_strong]:text-foreground",
        // Lists
        "[&_ul]:mb-4 [&_ul]:ml-6 [&_ul]:list-disc [&_ul]:space-y-1",
        "[&_ol]:mb-4 [&_ol]:ml-6 [&_ol]:list-decimal [&_ol]:space-y-1",
        "[&_li]:text-muted-foreground",
        // Links
        "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 hover:[&_a]:text-primary/80",
        // Code
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-2 [&_code]:py-1 [&_code]:font-mono [&_code]:text-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}
