import type { ComponentPropsWithoutRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "~/lib/utils";

/**
 * Markdown renderer for agent answers (and any short LLM-authored text).
 * Backed by react-markdown + remark-gfm (GitHub-flavored: tables, lists,
 * strikethrough). Element overrides keep it compact for dense surfaces like
 * the command palette rather than article-width `prose` spacing.
 *
 * Safe by default: react-markdown does not use dangerouslySetInnerHTML and
 * raw HTML in the source is not rendered.
 */

type ElementProps<T extends keyof React.JSX.IntrinsicElements> =
  ComponentPropsWithoutRef<T> & { node?: unknown };

// Strip the `node` prop react-markdown injects so it doesn't hit the DOM.
function clean<T extends keyof React.JSX.IntrinsicElements>({
  node: _node,
  ...rest
}: ElementProps<T>) {
  return rest;
}

const components = {
  p: (props: ElementProps<"p">) => (
    <p className="mb-2 leading-relaxed last:mb-0" {...clean(props)} />
  ),
  ul: (props: ElementProps<"ul">) => (
    <ul
      className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0"
      {...clean(props)}
    />
  ),
  ol: (props: ElementProps<"ol">) => (
    <ol
      className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0"
      {...clean(props)}
    />
  ),
  li: (props: ElementProps<"li">) => (
    <li className="leading-relaxed" {...clean(props)} />
  ),
  strong: (props: ElementProps<"strong">) => (
    <strong className="font-semibold" {...clean(props)} />
  ),
  em: (props: ElementProps<"em">) => (
    <em className="italic" {...clean(props)} />
  ),
  a: (props: ElementProps<"a">) => (
    <a
      className="text-primary underline underline-offset-2 hover:text-primary/80"
      target="_blank"
      rel="noopener noreferrer"
      {...clean(props)}
    />
  ),
  code: (props: ElementProps<"code">) => (
    <code
      className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
      {...clean(props)}
    />
  ),
  pre: (props: ElementProps<"pre">) => (
    <pre
      className="mb-2 overflow-x-auto rounded-md bg-muted p-2 text-xs last:mb-0 [&>code]:bg-transparent [&>code]:p-0"
      {...clean(props)}
    />
  ),
  h1: (props: ElementProps<"h1">) => (
    <h1
      className="mb-1 font-heading font-semibold text-base"
      {...clean(props)}
    />
  ),
  h2: (props: ElementProps<"h2">) => (
    <h2
      className="mb-1 font-heading font-semibold text-base"
      {...clean(props)}
    />
  ),
  h3: (props: ElementProps<"h3">) => (
    <h3 className="mb-1 font-heading font-semibold text-sm" {...clean(props)} />
  ),
  table: (props: ElementProps<"table">) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full text-left text-xs" {...clean(props)} />
    </div>
  ),
  th: (props: ElementProps<"th">) => (
    <th
      className="border-border border-b px-2 py-1 font-medium"
      {...clean(props)}
    />
  ),
  td: (props: ElementProps<"td">) => (
    <td className="border-border/50 border-b px-2 py-1" {...clean(props)} />
  ),
  blockquote: (props: ElementProps<"blockquote">) => (
    <blockquote
      className="mb-2 border-border border-l-2 pl-3 text-muted-foreground last:mb-0"
      {...clean(props)}
    />
  ),
};

export function MarkdownText({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("text-sm", className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </Markdown>
    </div>
  );
}
