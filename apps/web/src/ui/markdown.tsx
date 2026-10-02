import { Children, type ComponentPropsWithoutRef, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";

import { selfLinkLabel } from "~/lib/link-label";
import { cn } from "~/lib/utils";

import { ShortcodeProse } from "./shortcode-prose";

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

/** Anchor styling shared with custom `a` overrides (see componentOverrides). */
const markdownAnchorClass =
  "text-primary underline underline-offset-2 hover:text-primary/80";

const linkifyTextChildren = (children: ReactNode) =>
  Children.map(children, (child) => {
    const text = z.string().safeParse(child);
    return text.success ? <ShortcodeProse>{text.data}</ShortcodeProse> : child;
  });

const components = {
  p: (props: ElementProps<"p">) => (
    <p className="mb-2 leading-relaxed last:mb-0" {...clean(props)}>
      {linkifyTextChildren(props.children)}
    </p>
  ),
  ul: (props: ElementProps<"ul">) => (
    <ul
      className="mb-2 list-disc space-y-0.5 pl-4 last:mb-0" /* tight */
      {...clean(props)}
    />
  ),
  ol: (props: ElementProps<"ol">) => (
    <ol
      className="mb-2 list-decimal space-y-0.5 pl-4 last:mb-0" /* tight */
      {...clean(props)}
    />
  ),
  li: (props: ElementProps<"li">) => (
    <li className="leading-relaxed" {...clean(props)}>
      {linkifyTextChildren(props.children)}
    </li>
  ),
  strong: (props: ElementProps<"strong">) => (
    <strong className="font-semibold" {...clean(props)}>
      {linkifyTextChildren(props.children)}
    </strong>
  ),
  em: (props: ElementProps<"em">) => (
    <em className="italic" {...clean(props)}>
      {linkifyTextChildren(props.children)}
    </em>
  ),
  del: (props: ElementProps<"del">) => (
    <del {...clean(props)}>{linkifyTextChildren(props.children)}</del>
  ),
  a: (props: ElementProps<"a">) => {
    const { href, children } = props;
    // A link whose visible text is just its own URL (the Notion import left
    // these in project notes) renders as a wall of raw URL; show a short
    // host+path label instead, keeping the full URL on hover.
    const text = z.string().safeParse(children);
    const label = text.success && href ? selfLinkLabel(href, text.data) : null;
    return (
      <a
        className={markdownAnchorClass}
        target="_blank"
        rel="noopener noreferrer"
        title={label ? href : undefined}
        {...clean(props)}
      >
        {label ?? children}
      </a>
    );
  },
  img: (props: ElementProps<"img">) => {
    const { alt = "", ...rest } = clean(props);
    return (
      // Bounded thumbnail so a stray embed degrades gracefully instead of
      // rendering full-bleed. Project images live in the gallery, not notes.
      <img
        alt={alt}
        className="my-2 max-h-48 w-auto rounded-md"
        loading="lazy"
        {...rest}
      />
    );
  },
  code: (props: ElementProps<"code">) => (
    <code
      className="rounded bg-muted px-1 py-0.5 font-mono text-xs" /* tight */
      {...clean(props)}
    />
  ),
  pre: (props: ElementProps<"pre">) => (
    <pre
      className="mb-2 overflow-x-auto rounded-md bg-muted p-2 text-xs last:mb-0 [&>code]:bg-transparent [&>code]:p-0"
      {...clean(props)}
    />
  ),
  h1: (props: ElementProps<"h1">) => {
    const { children, ...rest } = clean(props);
    return (
      <h1 className="mb-1 font-heading text-base font-semibold" {...rest}>
        {linkifyTextChildren(children)}
      </h1>
    );
  },
  h2: (props: ElementProps<"h2">) => {
    const { children, ...rest } = clean(props);
    return (
      <h2 className="mb-1 font-heading text-base font-semibold" {...rest}>
        {linkifyTextChildren(children)}
      </h2>
    );
  },
  h3: (props: ElementProps<"h3">) => {
    const { children, ...rest } = clean(props);
    return (
      <h3 className="mb-1 font-heading text-sm font-semibold" {...rest}>
        {linkifyTextChildren(children)}
      </h3>
    );
  },
  table: (props: ElementProps<"table">) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full text-left text-xs" {...clean(props)} />
    </div>
  ),
  th: (props: ElementProps<"th">) => (
    <th
      className="border-b border-border px-2 py-1 font-medium"
      {...clean(props)}
    >
      {linkifyTextChildren(props.children)}
    </th>
  ),
  td: (props: ElementProps<"td">) => (
    <td className="border-b border-border/50 px-2 py-1" {...clean(props)}>
      {linkifyTextChildren(props.children)}
    </td>
  ),
  blockquote: (props: ElementProps<"blockquote">) => (
    <blockquote
      className="mb-2 border-l-2 border-border pl-2 text-muted-foreground last:mb-0"
      {...clean(props)}
    >
      {linkifyTextChildren(props.children)}
    </blockquote>
  ),
};

export function MarkdownText({
  children,
  className,
  componentOverrides,
}: {
  children: string;
  className?: string;
  /** Per-element overrides merged over the defaults (e.g. a custom `a`). */
  componentOverrides?: Partial<typeof components>;
}) {
  return (
    <div className={cn("text-sm", className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={
          componentOverrides
            ? { ...components, ...componentOverrides }
            : components
        }
      >
        {children}
      </Markdown>
    </div>
  );
}
