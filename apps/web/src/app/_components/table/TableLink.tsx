import { cva, type VariantProps } from "class-variance-authority";
import Link from "next/link";
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

interface TableLinkProps extends VariantProps<typeof tableLinkVariants> {
  href: string;
  children: ReactNode;
  className?: string;
}

export const TableLink = ({
  href,
  children,
  className = "",
  variant,
}: TableLinkProps) => {
  return (
    <Link className={tableLinkVariants({ variant, className })} href={href}>
      {children}
    </Link>
  );
};
