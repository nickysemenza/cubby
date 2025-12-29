import type { ReactNode } from "react";
import { NoneState } from "~/app/_components/NoneState";
import { cn } from "~/lib/utils";

interface InfoRowProps {
  label: string;
  children?: ReactNode;
  className?: string;
}

export const InfoRow = ({ label, children, className }: InfoRowProps) => (
  <div className={cn(className)}>
    <span className="font-medium">{label}:</span> {children ?? <NoneState />}
  </div>
);
