import Link from "next/link";
import { type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";

const tableLinkVariants = cva("hover:underline transition-colors", {
  variants: {
    variant: {
      default: "font-medium text-blue-600 dark:text-blue-500",
      mono: "font-mono text-blue-600",
      muted:
        "font-medium text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200",
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
