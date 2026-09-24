import { Link, type LinkProps } from "@tanstack/react-router";
import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";
import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

type EntityFilterLinkProps = LinkProps & {
  /** Accessible action text, also shown in the icon variant's tooltip. */
  label: string;
  /** Wrap a readable value, or render the secondary filter action beside it. */
  variant?: "value" | "icon";
  children?: ReactNode;
  className?: string;
};

/**
 * Navigate from one entity's reusable metadata to the matching filtered list.
 *
 * Read-only facets use `value`, making the displayed text/chip the link.
 * Editable values and entity relationships keep their primary interaction and
 * place the `icon` variant beside it instead, so controls are never nested.
 */
export function EntityFilterLink({
  label,
  variant = "icon",
  children,
  className,
  ...linkProps
}: EntityFilterLinkProps) {
  if (variant === "value") {
    return (
      <Link
        {...linkProps}
        aria-label={label}
        className={cn(
          "group/filter inline-flex max-w-full items-center text-primary underline decoration-border/70 decoration-dotted underline-offset-2 transition-colors hover:decoration-primary hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {children}
      </Link>
    );
  }

  const link = (
    <Link
      {...linkProps}
      aria-label={label}
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-7",
        className,
      )}
    >
      <FunnelIcon className="size-3.5" />
    </Link>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
