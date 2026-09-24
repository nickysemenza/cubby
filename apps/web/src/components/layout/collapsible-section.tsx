import { CaretRightIcon as ChevronRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import type * as React from "react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { stackVariants } from "~/styles/layouts";

interface CollapsibleSectionProps extends Omit<
  React.HTMLAttributes<HTMLElement>,
  "title"
> {
  /** Section heading (rendered as an `h2` inside the disclosure summary). */
  title: ReactNode;
  /** Muted sub-line beside the title, visible while collapsed. */
  summary?: ReactNode;
  /** Open on first render. Defaults to closed. */
  defaultOpen?: boolean;
  ref?: React.Ref<HTMLElement>;
}

/**
 * A {@link Section} whose body is behind a disclosure — for a region that is
 * worth keeping on the page but not worth paying for on every landing.
 *
 * Native `<details>` for the semantics and keyboard behavior, but the body is
 * **mounted only while open** rather than left in the DOM under `display:none`.
 * That is load-bearing, not an optimization. A closed region costs nothing at
 * all — no queries, no chart runtime, no reserved DOM — so the disclosure is
 * itself the deferral gate, and children need no scroll-based lazy wrapper.
 * Anything relying on `IntersectionObserver` would in fact be broken here: it
 * never fires for content in a `display:none` subtree, so a scroll-gated child
 * parked inside a closed `<details>` would stay unmounted forever.
 */
export function CollapsibleSection({
  title,
  summary,
  defaultOpen = false,
  className,
  children,
  ref,
  ...props
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section
      className={cn(stackVariants({ gap: "md" }), className)}
      ref={ref}
      {...props}
    >
      <details
        className="group"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 border-b border-border pb-1 transition-colors hover:text-foreground sm:min-h-0 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 shrink-0 text-slate transition-transform group-open:rotate-90" />
          <h2 className="font-heading text-sm font-semibold">{title}</h2>
          {summary && (
            <span className="truncate font-mono text-2xs text-muted-foreground uppercase">
              {summary}
            </span>
          )}
        </summary>
        {open && (
          <div className={cn(stackVariants({ gap: "md" }), "pt-4")}>
            {children}
          </div>
        )}
      </details>
    </section>
  );
}

CollapsibleSection.displayName = "CollapsibleSection";
