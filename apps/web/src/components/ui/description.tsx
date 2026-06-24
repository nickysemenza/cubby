import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "~/lib/utils";

/**
 * Secondary/muted body text — the canonical replacement for standalone
 * `text-muted-foreground text-sm|xs` paragraphs (captions, helper text, section
 * descriptions). One axis (`size`); use `className` for anything else.
 */
const descriptionVariants = cva("text-muted-foreground", {
  variants: {
    size: { sm: "text-sm", xs: "text-xs", "2xs": "text-2xs" },
  },
  defaultVariants: { size: "sm" },
});

interface DescriptionProps
  extends React.HTMLAttributes<HTMLParagraphElement>,
    VariantProps<typeof descriptionVariants> {
  as?: React.ElementType;
  ref?: React.Ref<HTMLParagraphElement>;
}

export const Description = ({
  as: Comp = "p",
  size,
  className,
  ref,
  ...props
}: DescriptionProps) => (
  <Comp
    className={cn(descriptionVariants({ size }), className)}
    ref={ref}
    {...props}
  />
);

Description.displayName = "Description";
