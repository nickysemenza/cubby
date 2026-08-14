import type { FC } from "react";
import { cn } from "~/lib/utils";

interface NoneValueProps {
  className?: string;
}

/**
 * The "no value" mark. Slate Mark, not a dimmed tone: DESIGN.md's readable text
 * has exactly three steps (Ink, Shelf Ink, Slate Mark) and says not to invent a
 * fourth with opacity. This was `text-muted-foreground/30`, which rendered at
 * ~1.5:1 and appeared 57-86 times on a single list page.
 */
export const NoneValue: FC<NoneValueProps> = ({ className }) => {
  return (
    <span
      className={cn("select-none text-2xs text-slate", className)}
    >
      —
    </span>
  );
};
