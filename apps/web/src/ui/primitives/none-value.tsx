import type { FC } from "react";
import { cn } from "~/lib/utils";

interface NoneValueProps {
  className?: string;
}

export const NoneValue: FC<NoneValueProps> = ({ className }) => {
  return (
    <span
      className={cn("select-none text-muted-foreground/50", className)}
    >
      —
    </span>
  );
};
