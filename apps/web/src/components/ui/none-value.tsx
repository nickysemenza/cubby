import type { FC } from "react";
import { cn } from "~/lib/utils";

interface NoneValueProps {
  className?: string;
}

export const NoneValue: FC<NoneValueProps> = ({ className }) => {
  return (
    <span
      className={cn("select-none text-2xs text-muted-foreground/30", className)}
    >
      —
    </span>
  );
};
