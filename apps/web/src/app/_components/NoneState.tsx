import type { FC } from "react";
import { cn } from "~/lib/utils";

interface NoneStateProps {
  className?: string;
}

export const NoneState: FC<NoneStateProps> = ({ className }) => {
  return (
    <span
      className={cn("select-none text-2xs text-muted-foreground/30", className)}
    >
      —
    </span>
  );
};
