"use client";

import { type FC } from "react";
import { cn } from "~/lib/utils";

interface NoneStateProps {
  className?: string;
}

export const NoneState: FC<NoneStateProps> = ({ className }) => {
  return (
    <div
      className={cn(
        "bg-muted text-muted-foreground inline-flex items-center justify-center rounded-md px-3 py-1 text-sm",
        className,
      )}
    >
      None
    </div>
  );
};
