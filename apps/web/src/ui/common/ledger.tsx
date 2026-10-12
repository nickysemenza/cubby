import { createContext, type HTMLAttributes, useContext } from "react";

import { cn } from "~/lib/utils";

import "./ledger.css";

const LedgerContext = createContext<"facts" | "records" | null>(null);

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
      <LedgerContext.Provider value={variant}>
        <Component
          data-ledger={variant}
          className={cn("ledger", className)}
          {...props}
        />
      </LedgerContext.Provider>
    </div>
  );
}

export function LedgerRow({
  as: Component = "li",
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: "li" | "div" }) {
  // A row outside a Ledger loses its subgrid columns and misaligns silently.
  const ledger = useContext(LedgerContext);
  if (import.meta.env.DEV && ledger === null) {
    throw new Error("LedgerRow must render inside a Ledger");
  }
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
  slot:
    | "leading"
    | "primary"
    | "secondary"
    | "trailing"
    | "actions"
    | "detail"
    | "group";
}) {
  return (
    <Component
      data-ledger-slot={slot}
      className={cn("min-w-0", className)}
      {...props}
    />
  );
}
