import { Link } from "@tanstack/react-router";
import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import type {
  EntityDetailParams,
  EntityDetailRoute,
} from "~/entities/entities";

const tableLinkVariants = cva("transition-colors hover:underline", {
  variants: {
    variant: {
      default: "font-medium text-primary",
      mono: "font-mono text-primary",
      muted: "font-medium text-muted-foreground hover:text-foreground",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

/** USDA lookup routes (not standard entity routes) */
type USDALookupRoute =
  | { to: "/usda/upc/$code"; params: { code: string } }
  | { to: "/usda/ndb/$code"; params: { code: string } };

/**
 * Standard entity detail routes. `params` is the full `EntityDetailParams`
 * union, not `{ id: string }` — cookbook's route takes `cookbookId`, so the
 * narrower shape made `TableLink` unusable for polymorphic rows (the global
 * search table) even though it's the canonical entity link.
 */
type EntityRoute = { to: EntityDetailRoute; params: EntityDetailParams };

type TableLinkProps = VariantProps<typeof tableLinkVariants> & {
  children: ReactNode;
  className?: string;
} & (USDALookupRoute | EntityRoute);

export const TableLink = ({
  to,
  params,
  children,
  className = "",
  variant,
}: TableLinkProps) => {
  return (
    <Link
      className={tableLinkVariants({ variant, className })}
      to={to}
      params={params}
    >
      {children}
    </Link>
  );
};
