import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "~/lib/utils";

/**
 * Icon-in-a-shape tile — the canonical replacement for the repeated
 * `flex h-N w-N items-center justify-center rounded-* bg-*` wrapper around a
 * single icon. Pass an entity/custom color via `className` (e.g. an entity's
 * `color.bg`/`color.text`); the `tone` variants cover the common muted/primary
 * cases. Keep it lean — two axes only (size, tone).
 */
const iconTileVariants = cva(
  "inline-flex shrink-0 items-center justify-center rounded-lg [&>svg]:shrink-0",
  {
    variants: {
      size: {
        // Calibrated to the real tile sizes pages use (h-7 / h-8 / h-10) so a
        // tile sits flush with sibling h-8 image thumbnails. md = 32px (was 36).
        sm: "size-7 [&>svg]:size-3.5",
        md: "size-8 [&>svg]:size-4",
        lg: "size-10 [&>svg]:size-5",
      },
      tone: {
        muted: "bg-muted text-muted-foreground",
        primary: "bg-primary/10 text-primary",
      },
    },
    defaultVariants: { size: "md", tone: "muted" },
  },
);

interface IconTileProps
  extends React.HTMLAttributes<HTMLElement>,
    VariantProps<typeof iconTileVariants> {
  as?: React.ElementType;
  ref?: React.Ref<HTMLElement>;
}

export const IconTile = ({
  as: Comp = "span",
  size,
  tone,
  className,
  ref,
  ...props
}: IconTileProps) => (
  <Comp
    className={cn(iconTileVariants({ size, tone }), className)}
    ref={ref}
    {...props}
  />
);

IconTile.displayName = "IconTile";
