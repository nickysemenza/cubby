import type { RecipeSource } from "@cubby/schemas/recipe-shared";
import { ArrowSquareOutIcon as ExternalLink } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { BookOpenIcon as BookOpen } from "@phosphor-icons/react/dist/csr/BookOpen";
import { Link } from "@tanstack/react-router";
import type { MouseEvent } from "react";
import { match, P } from "ts-pattern";

import { cn } from "~/lib/utils";

// One place owns how a recipe's source is presented — the book/website/notion
// dispatch, the URL-host parsing, and the icon+link scaffold — so the recipe
// list, compare grid, hero, and spec footnote can't drift on labels or links.

/** Host of a source URL, www-stripped; falls back to the raw string on parse error. */
const sourceHost = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Short label for a recipe source: book title, else the URL host. null ⇒ no source. */
export const sourceLabel = (
  source: RecipeSource | null | undefined,
): string | null =>
  match(source)
    .with({ type: "book" }, (s) => s.book)
    .with({ type: P.union("website", "notion") }, (s) => sourceHost(s.url))
    .otherwise(() => null);

/** A short italic attribution — MC's footer line: "(from Book)" / "(via host)". */
export const sourceFootnote = (
  source: RecipeSource | null | undefined,
): string | null =>
  match(source)
    .with({ type: "book" }, (s) => `(from ${s.book})`)
    .with({ type: P.union("website", "notion") }, (s) => {
      const host = sourceHost(s.url);
      return host ? `(via ${host})` : null;
    })
    .otherwise(() => null);

/**
 * The recipe-source link scaffold: a cookbook Link for book sources (a plain
 * span when there's no cookbookId), an external anchor for website/notion.
 * Renders null for other/absent sources — callers supply their own empty state
 * (guard with {@link sourceLabel}). `text` picks the website label: the host
 * (default) or the full url.
 */
export function RecipeSourceLink({
  source,
  iconSize = 14,
  text = "host",
  className,
  onClick,
}: {
  source: RecipeSource | null | undefined;
  iconSize?: number;
  text?: "host" | "url";
  className?: string;
  onClick?: (e: MouseEvent) => void;
}) {
  const rowCn = cn("flex min-w-0 items-center gap-2", className);
  return match(source)
    .with({ type: "book" }, (s) => {
      const body = (
        <>
          <BookOpen size={iconSize} className="shrink-0" />
          <span className="truncate">{s.book}</span>
        </>
      );
      return s.cookbookId ? (
        <Link
          to="/cookbooks/$shortcode"
          params={{ shortcode: s.cookbookId }}
          className={cn(rowCn, "hover:underline")}
          onClick={onClick}
        >
          {body}
        </Link>
      ) : (
        <span className={rowCn}>{body}</span>
      );
    })
    .with({ type: P.union("website", "notion") }, (s) => (
      <a
        href={s.url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(rowCn, "hover:underline")}
        onClick={onClick}
      >
        <ExternalLink size={iconSize} className="shrink-0" />
        <span className="truncate">
          {text === "url" ? s.url : sourceHost(s.url)}
        </span>
      </a>
    ))
    .otherwise(() => null);
}
