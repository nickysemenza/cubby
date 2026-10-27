import type { ReactNode } from "react";

import { SourceStack } from "./source-stack";

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
    <SourceStack
      label="Value decision chain"
      rows={levels.map((level) => ({
        key: level,
        status: level === deciding ? "deciding" : "skipped",
        title: labels[level],
        children: children(level),
      }))}
    />
  );
}
