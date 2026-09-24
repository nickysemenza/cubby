import type { Icon } from "@phosphor-icons/react/lib";
import * as React from "react";

import { cn } from "~/lib/utils";

function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & {
  size?: "default" | "sm";
}) {
  return (
    <div
      data-slot="card"
      data-size={size}
      // Porcelain Transit panels use white surfaces, hairlines, and modest
      // radii. Resting cards remain shadow-free.
      className={cn(
        "bg-card text-card-foreground group/card flex flex-col gap-3 overflow-hidden rounded-md border border-[var(--border)] py-3 text-xs/relaxed has-[>img:first-child]:pt-0 data-[size=sm]:gap-2 data-[size=sm]:py-2.5",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 px-3.5 sm:px-4 group-data-[size=sm]/card:px-3 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-3 group-data-[size=sm]/card:[.border-b]:pb-2.5",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({
  className,
  icon: Icon,
  as: Comp = "div",
  children,
  ...props
}: React.ComponentProps<"div"> & {
  icon?: Icon;
  /**
   * Render as a real heading where the card is a named region of the page
   * rather than incidental chrome. A card title looks like a heading and is
   * read as one, but defaulted to `div` — so a dashboard of ten cards exposed
   * zero of them to heading navigation. Pass the level that fits the page's
   * outline; the visual treatment is identical either way.
   */
  as?: "div" | "h2" | "h3" | "h4";
}) {
  return (
    <Comp
      data-slot="card-title"
      // Cards use compact sentence-case headings; callers may still opt into
      // the shared eyebrow treatment for specialist data sections.
      className={cn(
        "flex items-center gap-2 text-sm font-semibold tracking-tight",
        className,
      )}
      {...props}
    >
      {Icon && <Icon className="size-3.5 shrink-0" />}
      {children}
    </Comp>
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground text-xs/relaxed", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      // Content owns only horizontal padding; the card container owns vertical
      // rhythm (its `py-3` + `gap-3` between header/content). So don't pass `p-3`
      // / `px-4 py-1` overrides — they fight the container and were the source of
      // the per-card padding drift. `space-y-*` for inner spacing is fine; use
      // `p-0` only to deliberately run content flush to the card edge (tables).
      className={cn("px-3.5 sm:px-4 group-data-[size=sm]/card:px-3", className)}
      {...props}
    />
  );
}

export {
  Card,
  CardHeader,

  CardTitle,
  CardDescription,
  CardContent,
};
