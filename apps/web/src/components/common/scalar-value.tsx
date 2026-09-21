import { format } from "date-fns";
import type { ReactNode } from "react";

import { HoverableTimestamp } from "~/app/_components/HoverableTimestamp";
import JsonRenderer from "~/app/_components/json-renderer";
import { EnumPill } from "~/components/ui/enum-pill";
import { NoneValue } from "~/components/ui/none-value";
import { parsePlainDate } from "~/lib/plain-date";

export type ScalarDisplayValue =
  | { kind: "empty"; raw: null | undefined }
  | { kind: "text"; raw: string; label: string }
  /** A declared enum value with its roster presentation; `raw` stays the
   * stored value for copy, sort, and filter seeds. */
  | {
      kind: "enum";
      raw: string;
      label: string;
      color: string;
      icon?: ReactNode;
    }
  | { kind: "number"; raw: number }
  | { kind: "boolean"; raw: boolean }
  | { kind: "date"; raw: string }
  | { kind: "timestamp"; raw: string | Date }
  | { kind: "list"; raw: string[] }
  /** A structured value with no domain renderer; shown as readable JSON. */
  | { kind: "json"; raw: unknown };

export function renderScalarValue(
  value: ScalarDisplayValue,
  surface: "list" | "detail" | "plain" = "plain",
): ReactNode {
  switch (value.kind) {
    case "empty":
      return value.raw === undefined ? undefined : <NoneValue />;
    case "timestamp":
      return <HoverableTimestamp timestamp={value.raw} />;
    case "date":
      return format(parsePlainDate(value.raw), "MMM d, yyyy");
    case "boolean":
      return value.raw ? "Yes" : "No";
    case "number":
      return value.raw;
    case "list":
      return value.raw.length ? value.raw.join(", ") : <NoneValue />;
    case "json":
      return <JsonRenderer input={value.raw} />;
    case "enum":
      if (surface === "plain") return value.label;
      return (
        <EnumPill color={value.color} icon={value.icon}>
          {value.label}
        </EnumPill>
      );
    case "text":
      if (surface === "plain") return value.label || <NoneValue />;
      return value.label ? (
        <span
          className={
            surface === "list"
              ? "block truncate"
              : "break-words whitespace-pre-wrap"
          }
          title={surface === "list" ? value.label : undefined}
        >
          {value.label}
        </span>
      ) : (
        <NoneValue />
      );
  }
}
