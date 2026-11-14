import { machineryRowStatusLabel } from "@cubby/schemas/field-envelope-presentation";
import type { ReactNode } from "react";

import { SourceStack } from "./source-stack";

/** A field's levels in precedence order (ADR 0029 section 10, field scope). */
export type DecisionLevel = "own" | "source" | "cubby" | "waiting" | "pending";

/**
 * One chain in precedence order with the deciding level filled and the rest
 * muted. The rows never change between load states; only their words and the
 * deciding level fill in.
 */
export function DecisionLevels({
  deciding,
  rows,
}: {
  deciding?: DecisionLevel;
  rows: readonly {
    level: DecisionLevel;
    title: ReactNode;
    children?: ReactNode;
  }[];
}) {
  return (
    <SourceStack
      label="Value decision chain"
      rows={rows.map((row) => {
        const status =
          row.level !== deciding
            ? "skipped"
            : row.level === "waiting"
              ? "gap"
              : "used";
        return {
          key: row.level,
          status: status === "used" ? "deciding" : status,
          statusLabel: machineryRowStatusLabel(status),
          title: row.title,
          children: row.children,
        };
      })}
    />
  );
}
