import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * Minimal inline markdown renderer for short agent answers. Handles the small
 * subset Haiku emits — **bold**, *italic*, and `code` — while leaving line and
 * list structure to the parent's `whitespace-pre-wrap`. Deliberately not a full
 * markdown engine (no dependency); swap in react-markdown if answers grow to
 * need headings/tables/links.
 */

// Matches **bold**, *italic* (single, non-greedy), or `code`.
const TOKEN = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;

function renderInline(text: string): ReactNode[] {
  const parts = text.split(TOKEN);
  return parts.map((part, i) => {
    // biome-ignore lint/suspicious/noArrayIndexKey: positional tokens from a stable split
    const key = i;
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={key}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

export function MarkdownText({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("whitespace-pre-wrap", className)}>
      {renderInline(children)}
    </div>
  );
}
