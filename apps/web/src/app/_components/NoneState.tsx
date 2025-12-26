"use client";

import type { FC } from "react";
import { cn } from "~/lib/utils";
import { EntityPill } from "./EntityPill";

interface NoneStateProps {
  className?: string;
}

export const NoneState: FC<NoneStateProps> = ({ className }) => {
  return (
    <span className={cn("italic", className)}>
      <EntityPill text="None" />
    </span>
  );
};
