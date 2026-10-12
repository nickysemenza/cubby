import type { HTMLAttributes } from "react";

import { cn } from "~/lib/utils";

import "./ledger.css";

/** Shared row geometry; record links, editing, commands and evidence stay with callers. */
export function Ledger({
  as: Component = "ul",
  variant = "records",
  className,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: "ul" | "dl" | "div";
  variant?: "facts" | "records";
}) {
  return (
    <div className="ledger-container min-w-0">
      <Component
        data-ledger={variant}
        className={cn("ledger", className)}
        {...props}
      />
    </div>
  );
}

export function LedgerRow({
  as: Component = "li",
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: "li" | "div" }) {
  return <Component className={cn("ledger-row", className)} {...props} />;
}

/** Native tags keep description-list semantics; slot names express alignment, not behavior. */
export function LedgerCell({
  as: Component = "span",
  slot,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: "span" | "div" | "dt" | "dd";
  slot: "leading" | "primary" | "secondary" | "trailing" | "actions" | "detail";
}) {
  return (
    <Component
      data-ledger-slot={slot}
      className={cn("min-w-0", className)}
      {...props}
    />
  );
}
