import type * as React from "react";
import { cn } from "~/lib/utils";
import { type StackVariants, stackVariants } from "~/styles/layouts";

interface StackProps extends React.HTMLAttributes<HTMLElement>, StackVariants {
  /** Render as a different element (e.g. "ul", "section"). */
  as?: React.ElementType;
  ref?: React.Ref<HTMLElement>;
}

/**
 * Vertical block stack — the canonical replacement for `space-y-*`. Maps to
 * `space-y-*` under the hood (a 1:1 swap with no display-model change).
 */
export const Stack = ({
  as: Comp = "div",
  className,
  gap,
  align,
  ref,
  ...props
}: StackProps) => {
  return (
    <Comp
      className={cn(stackVariants({ gap, align }), className)}
      ref={ref}
      {...props}
    />
  );
};

Stack.displayName = "Stack";
