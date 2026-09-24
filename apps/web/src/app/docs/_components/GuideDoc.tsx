import { useEffect, useState, type ComponentPropsWithoutRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { resolveDocHref } from "../doc-paths";
import { Prose } from "./Prose";

/**
 * Renders a Markdown guide from the repo docs tree. Reuses {@link Prose}
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

function componentsFor(sourcePath: string) {
  return {
    a: (props: ElementProps<"a">) => (
      <a
        {...clean(props)}
        href={props.href ? resolveDocHref(props.href, sourcePath) : undefined}
      >
        {props.children}
      </a>
    ),
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
        className="border-b border-border px-2 py-1 font-medium text-foreground"
        {...clean(props)}
      />
    ),
    td: (props: ElementProps<"td">) => (
      <td
        className="border-b border-border/50 px-2 py-1 align-top text-muted-foreground"
        {...clean(props)}
      />
    ),
    blockquote: (props: ElementProps<"blockquote">) => (
      <blockquote
        className="my-4 border-l border-primary/40 bg-muted/40 py-2 pl-2 text-muted-foreground"
        {...clean(props)}
      />
    ),
    hr: (props: ElementProps<"hr">) => (
      <hr className="my-6 border-border" {...clean(props)} />
    ),
  };
}

export function GuideDoc({
  sourcePath,
  sourceUrl,
}: {
  sourcePath: string;
  sourceUrl: string;
}) {
  const [markdown, setMarkdown] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    fetch(sourceUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then(setMarkdown)
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, [sourceUrl]);

  if (error) return <p role="alert">Could not load documentation: {error}</p>;
  if (markdown === undefined) return <output>Loading documentation…</output>;

  return (
    <Prose>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={componentsFor(sourcePath)}
      >
        {markdown}
      </Markdown>
    </Prose>
  );
}
