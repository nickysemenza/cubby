import type { ReactNode } from "react";
import { NoneState } from "~/app/_components/NoneState";
import { cn } from "~/lib/utils";

interface InfoRowProps {
  label: string;
  children?: ReactNode;
  className?: string;
}

/**
 * One line of the entity "fact sheet" — ledger-style: a mono eyebrow label
 * column with the value set beside it. Stack inside a `divide-y divide-dashed`
 * container (see BasicInfo) for the grocer's-ledger rules between rows.
 */
export const InfoRow = ({ label, children, className }: InfoRowProps) => (
  <div
    className={cn(
      "grid grid-cols-[7.5rem_minmax(0,1fr)] items-baseline gap-2 py-1.5",
      className,
    )}
  >
    <span className="font-mono text-2xs text-eyebrow uppercase tracking-wider">
      {label}
    </span>
    <span className="min-w-0 text-sm">{children ?? <NoneState />}</span>
  </div>
);
