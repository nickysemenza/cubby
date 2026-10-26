import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

type DecisionLevel = "own" | "accepted" | "inherited" | "default" | "pending";
const levels: readonly DecisionLevel[] = [
  "own",
  "accepted",
  "inherited",
  "default",
  "pending",
];
const labels = {
  own: "Set here",
  accepted: "Accepted suggestion",
  inherited: "Inherited",
  default: "Default",
  pending: "Pending suggestion",
};

export function DecisionLevels({
  deciding,
  children,
}: {
  deciding?: string;
  children: (level: DecisionLevel) => ReactNode;
}) {
  return (
    <ol aria-label="Value decision chain" className="grid gap-0 text-xs">
      {levels.map((level) => (
        <li
          key={level}
          className={cn(
            "relative grid grid-cols-[12px_minmax(0,1fr)] gap-x-2 py-2 before:absolute before:inset-y-0 before:left-1 before:border-l before:border-border first:before:top-3 last:before:bottom-3",
            level !== deciding && "text-muted-foreground",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "relative mt-1 size-2 rounded-full border border-current bg-popover",
              level === deciding && "bg-foreground text-foreground",
            )}
          />
          <div className="grid min-w-0 gap-1">
            <span
              className={cn(
                level === deciding && "font-semibold text-foreground",
              )}
            >
              {labels[level]}
              {level === deciding ? (
                <span className="sr-only"> · Decides this value</span>
              ) : null}
            </span>
            {children(level)}
          </div>
        </li>
      ))}
    </ol>
  );
}
