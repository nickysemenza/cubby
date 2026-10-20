import type * as React from "react";

import { cn } from "~/lib/utils";
import {
  DisclosureBody,
  DisclosureRoot,
  type DisclosureState,
  DisclosureTrigger,
} from "~/ui/layout/disclosure";

// Adapted from the shadcn base-mira `trace` registry item (AI Elements):
// running lines show a spinner icon instead of the registry's shimmer utility.

function Trace({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="trace"
      className={cn("flex w-full min-w-0 flex-col gap-0.5", className)}
      {...props}
    />
  );
}

function TraceLine({
  className,
  status,
  ...props
}: React.ComponentProps<"span"> & {
  status?: "running" | "error" | "pending";
}) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cn(
        "flex w-fit max-w-full min-w-0 items-center gap-1.5 font-mono text-xs/5 text-muted-foreground transition-colors data-[status=error]:text-destructive data-[status=pending]:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

function TraceIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

function TraceTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-title"
      className={cn("min-w-0 truncate", className)}
      {...props}
    />
  );
}

function TraceDescription({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-description"
      className={cn(
        "shrink-0 text-muted-foreground/70 tabular-nums",
        className,
      )}
      {...props}
    />
  );
}

function TraceCollapsible({
  className,
  children,
  ...state
}: Omit<DisclosureState, "keepMounted"> & {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <DisclosureRoot
      state={state}
      className={cn("flex w-full min-w-0 flex-col", className)}
    >
      {children}
    </DisclosureRoot>
  );
}

function TraceCollapsibleTrigger({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <DisclosureTrigger className={cn("w-fit max-w-full", className)}>
      {children}
    </DisclosureTrigger>
  );
}

function TraceCollapsibleContent({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <DisclosureBody className="min-w-0">
      <div
        className={cn(
          "mt-1 mb-1.5 ml-1.5 grid min-w-0 gap-1.5 border-l border-border pl-3 wrap-break-word",
          className,
        )}
      >
        {children}
      </div>
    </DisclosureBody>
  );
}

export {
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
};
