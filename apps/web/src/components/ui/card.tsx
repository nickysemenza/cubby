import * as React from "react";

import { cn } from "~/lib/utils";

function Card({
  className,
  size = "default",
  emphasis = "soft",
  ...props
}: React.ComponentProps<"div"> & {
  size?: "default" | "sm";
  /** "chunky" swaps the soft ring for a tactile 2px border + offset shadow. */
  emphasis?: "soft" | "chunky";
}) {
  return (
    <div
      data-slot="card"
      data-size={size}
      data-emphasis={emphasis}
      className={cn(
        "bg-card text-card-foreground group/card flex flex-col gap-3 overflow-hidden rounded-lg py-3 text-xs/relaxed has-[>img:first-child]:pt-0 data-[size=sm]:gap-2 data-[size=sm]:py-2 *:[img:first-child]:rounded-t-lg *:[img:last-child]:rounded-b-lg",
        emphasis === "chunky"
          ? "border-[var(--border-chunky)] border-2 shadow-[var(--shadow-chunky)]"
          : "ring-foreground/10 ring-1",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A clickable, radio-style card for "pick one of these" surfaces (e.g. choosing
 * a location to move items into). Selected = thick foreground border + offset
 * shadow; unselected = a thin inner ring. The border width is reserved on both
 * states (transparent when unselected) so selecting never shifts layout.
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
          ? "border-[var(--border-chunky)] border-2 shadow-[var(--shadow-chunky)]"
          : "hover:border-foreground/40 border-2 border-transparent ring-1 ring-border/80 ring-inset",
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
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-lg px-4 group-data-[size=sm]/card:px-3 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-4 group-data-[size=sm]/card:[.border-b]:pb-3",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("text-sm font-medium", className)}
      {...props}
    />
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
      className={cn("px-4 group-data-[size=sm]/card:px-3", className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-lg px-4 group-data-[size=sm]/card:px-3 [.border-t]:pt-4 group-data-[size=sm]/card:[.border-t]:pt-3",
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
