import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/** A section's heading line: the component names exactly as imported, then
 * their source paths relative to `apps/web/src`. */
export function ComponentsLine({
  components,
  source,
}: {
  components: readonly string[];
  source: readonly string[];
}) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-2xs">
      <span className="text-foreground">{components.join(" · ")}</span>
      {source.map((path) => (
        <span key={path}>{path}</span>
      ))}
    </span>
  );
}

/** A labelled demo tile; `name` is the component and the props that produce it. */
export function Demo({
  name,
  note,
  className,
  children,
}: {
  name: string;
  note?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-md border bg-card p-3",
        className,
      )}
    >
      <figcaption className="flex flex-col gap-0.5">
        <code className="font-mono text-2xs text-foreground">{name}</code>
        {note ? (
          <span className="text-xs text-muted-foreground">{note}</span>
        ) : null}
      </figcaption>
      {children}
    </figure>
  );
}

export function DemoGrid({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("grid gap-3 md:grid-cols-2 xl:grid-cols-3", className)}>
      {children}
    </div>
  );
}
