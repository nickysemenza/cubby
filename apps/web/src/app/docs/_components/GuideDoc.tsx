import type { ComponentPropsWithoutRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prose } from "./Prose";

/**
 * Renders a repo `docs/*.md` guide inline on the docs page. Reuses {@link Prose}
 * for heading/paragraph/list/code typography (so guides match the rest of the
 * page) and only overrides the GFM elements Prose doesn't style — tables,
 * blockquote callouts, and rules. Raw HTML in the source is ignored by
 * react-markdown, same as {@link MarkdownText}.
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
  table: (props: ElementProps<"table">) => (
    <div className="my-4 overflow-x-auto">
      <table
        className="w-full border-collapse text-left text-sm"
        {...clean(props)}
      />
    </div>
  ),
  th: (props: ElementProps<"th">) => (
    <th
      className="border-border border-b px-2 py-1 font-medium text-foreground"
      {...clean(props)}
    />
  ),
  td: (props: ElementProps<"td">) => (
    <td
      className="border-border/50 border-b px-2 py-1 align-top text-muted-foreground"
      {...clean(props)}
    />
  ),
  blockquote: (props: ElementProps<"blockquote">) => (
    <blockquote
      className="my-4 border-primary/40 border-l-2 bg-muted/40 py-2 pl-2 text-muted-foreground"
      {...clean(props)}
    />
  ),
  hr: (props: ElementProps<"hr">) => (
    <hr className="my-6 border-border" {...clean(props)} />
  ),
};

export function GuideDoc({ children }: { children: string }) {
  return (
    <Prose>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </Markdown>
    </Prose>
  );
}
