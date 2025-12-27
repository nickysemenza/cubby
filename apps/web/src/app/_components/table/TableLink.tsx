import { Link } from "@tanstack/react-router";
import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";

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

// Type-safe overloads for known routes
type TableLinkProps = VariantProps<typeof tableLinkVariants> & {
  children: ReactNode;
  className?: string;
} & (
    | { to: "/usda/upc/$code"; params: { code: string } }
    | { to: "/usda/ndb/$code"; params: { code: string } }
    | { to: "/usda/$id"; params: { id: string } }
    | { to: "/products/$id"; params: { id: string } }
    | { to: "/locations/$id"; params: { id: string } }
    | { to: "/recipes/$id"; params: { id: string } }
    | { to: "/ingredients/$id"; params: { id: string } }
    | { to: "/inventory/$id"; params: { id: string } }
    | { to: "/images/$id"; params: { id: string } }
  );

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
      to={to as "/usda/upc/$code"}
      params={params as { code: string }}
    >
      {children}
    </Link>
  );
};
