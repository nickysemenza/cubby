import type { Icon } from "@phosphor-icons/react/lib";
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";

type EmptyStateProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  /**
   * `inline`: one muted line in a dashed slot inside a section, with inline
   * links ("No purchases yet. Add one or import an order email.").
   * `page`: a whole table or page — a centred icon, one sentence and one
   * secondary button.
   */
  size: "inline" | "page";
  /** One sentence naming what is absent. */
  children: ReactNode;
  /** Inline: links that continue the sentence. Page: one secondary button. */
  action?: ReactNode;
  /** Page only: a quiet 20px mark for what is absent. */
  icon?: Icon;
  /** Page only: a muted second line when the sentence alone cannot explain. */
  description?: ReactNode;
};

/** Absent results read as absent, never as loading or failure. */
export function EmptyState({
  size,
  children,
  action,
  icon: Mark,
  description,
  className,
  ...props
}: EmptyStateProps) {
  if (size === "inline") {
    return (
      <div
        data-slot="empty-state"
        data-size="inline"
        className={cn(
          "rounded-sm border border-dashed border-hairline-strong px-3 py-2.5 text-sm/4.5 text-muted-foreground [&_a]:text-link [&_a]:hover:underline",
          className,
        )}
        {...props}
      >
        {children}
        {action != null && <> {action}</>}
      </div>
    );
  }
  return (
    <div
      data-slot="empty-state"
      data-size="page"
      className={cn(
        "flex w-full min-w-0 flex-col items-center justify-center px-4 py-3 text-center text-sm/4.5 text-balance text-foreground",
        className,
      )}
      {...props}
    >
      {Mark && (
        <Mark aria-hidden className="mb-1.5 size-5 text-muted-foreground" />
      )}
      <p className="max-w-md">{children}</p>
      {description != null && (
        <p className="mt-0.5 max-w-md text-xs/4.5 text-muted-foreground">
          {description}
        </p>
      )}
      {action != null && <div className="mt-2">{action}</div>}
    </div>
  );
}
