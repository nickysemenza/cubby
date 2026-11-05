import { cn } from "cn";
import type { FC } from "react";

import { formatText } from "~/lib/display-format";

interface NoneValueProps {
  className?: string;
}

export const NoneValue: FC<NoneValueProps> = ({ className }) => {
  return (
    <span className={cn("text-muted-foreground/50 select-none", className)}>
      {formatText(undefined)}
    </span>
  );
};
