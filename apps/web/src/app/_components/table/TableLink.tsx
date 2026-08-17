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
 * union (`{ shortcode }`) for the shortcode-bearing entities, or `{ id }` for
 * `image` — the one entity `EntityDetailRoute` covers that stays keyed on its
 * uuid (`/images/$id`; `usda-food` never routes through `TableLink`).
 */
type EntityRoute = {
  to: EntityDetailRoute;
  params: EntityDetailParams | { id: string };
};

type TableLinkProps = VariantProps<typeof tableLinkVariants> & {
  children: ReactNode;
  className?: string;
  title?: string;
} & (USDALookupRoute | EntityRoute);

export const TableLink = ({
  to,
  params,
  children,
  className = "",
  title,
  variant,
}: TableLinkProps) => {
  return (
    <Link
      className={tableLinkVariants({ variant, className })}
      to={to}
      params={params}
      title={title}
    >
      {children}
    </Link>
  );
};
