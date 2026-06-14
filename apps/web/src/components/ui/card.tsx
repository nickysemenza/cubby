import type { LucideIcon } from "lucide-react";
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
      // One card surface (2026-06-12 consolidation): a defined hairline border
      // + soft elevation, everywhere. The old soft(ring)/chunky(border) split
      // had visually converged after the crisp refresh, so `emphasis` is gone.
      className={cn(
        "bg-card text-card-foreground group/card flex flex-col gap-2.5 overflow-hidden rounded-lg border border-[var(--border-chunky)] py-2.5 text-xs/relaxed shadow-[var(--shadow-chunky)] has-[>img:first-child]:pt-0 data-[size=sm]:gap-2 data-[size=sm]:py-2 *:[img:first-child]:rounded-t-lg *:[img:last-child]:rounded-b-lg",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A clickable, radio-style card for "pick one of these" surfaces (e.g. choosing
 * a location to move items into). Selected = primary hairline border +
 * elevation; unselected = a thin inner ring. The border width is reserved on
 * both states (transparent when unselected) so selecting never shifts layout.
 */
function SelectableCard({
  className,
  selected = false,
  size = "default",
  ...props
}: React.ComponentProps<"button"> & {
  selected?: boolean;
  size?: "default" | "sm";
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-slot="card"
      data-size={size}
      data-selected={selected}
      className={cn(
        "bg-card text-card-foreground group/card ease-cozy flex w-full flex-col gap-1 overflow-hidden rounded-lg px-4 py-3 text-left text-xs/relaxed transition-all outline-none",
        "focus-visible:ring-ring/40 focus-visible:ring-2",
        selected
          ? "border-primary border shadow-[var(--shadow-chunky)]"
          : "hover:border-foreground/40 border border-transparent ring-1 ring-border/80 ring-inset",
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
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-lg px-3.5 group-data-[size=sm]/card:px-3 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-3.5 group-data-[size=sm]/card:[.border-b]:pb-3",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({
  className,
  icon: Icon,
  children,
  ...props
}: React.ComponentProps<"div"> & { icon?: LucideIcon }) {
  return (
    <div
      data-slot="card-title"
      // Ledger-style section label — cards are "ledger blocks" and their titles
      // read as mono eyebrows (INGREDIENTS, HISTORY, ...). Pass `icon` for the
      // common eyebrow-with-leading-icon header. The one sanctioned className
      // override is a size bump for "numeral-as-title" stat cards (text-2xl).
      className={cn(
        "flex items-center gap-2 font-mono text-2xs font-medium uppercase tracking-wider text-eyebrow",
        className,
      )}
      {...props}
    >
      {Icon && <Icon className="size-3.5 shrink-0" />}
      {children}
    </div>
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

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className,
      )}
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
      className={cn("px-3.5 group-data-[size=sm]/card:px-3", className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-lg px-3.5 group-data-[size=sm]/card:px-3 [.border-t]:pt-3.5 group-data-[size=sm]/card:[.border-t]:pt-3",
        className,
      )}
      {...props}
    />
  );
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
  SelectableCard,
};
