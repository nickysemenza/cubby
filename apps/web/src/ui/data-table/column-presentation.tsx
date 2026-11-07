import type { Entity } from "@cubby/schemas/entity";
import { createContext, useContext, type ReactNode } from "react";

/** App composition supplies canonical marks without coupling shared UI to entities. */
export const ColumnMarkContext = createContext<
  ((entity: Entity, className: string) => ReactNode) | null
>(null);

import type { CubbyColumnMeta } from "./table-meta";

type ColumnIdentity = Pick<
  CubbyColumnMeta,
  "headerEntity" | "linksTo" | "countOf"
>;

/** Declaration-owned identity shared by headers and the column manager. */
export function columnEntityTarget(meta: ColumnIdentity | undefined) {
  return meta?.headerEntity ?? meta?.linksTo ?? meta?.countOf;
}

/** Describe declared value semantics; missing metadata stays unspecified. */
export function columnTypeLabel(
  meta:
    | Pick<
        CubbyColumnMeta,
        "headerEntity" | "linksTo" | "countOf" | "valueKind" | "filterConfig"
      >
    | undefined,
) {
  if (meta?.countOf) return "count";
  if (meta?.headerEntity || meta?.linksTo) return "record";
  if (meta?.valueKind)
    return {
      text: "text",
      enum: "choice",
      date: "date",
      money: "money",
      number: "number",
      person: "person",
      boolean: "yes / no",
    }[meta.valueKind];
  const filter = meta?.filterConfig;
  if (filter?.dateRange) return "date range";
  if (filter?.numberRange) return "number range";
  if (filter?.referenceEntity) return "record";
  if (!filter?.valueType) return undefined;
  return {
    entity: "record",
    enum: "choice",
    boolean: "yes / no",
    presence: "yes / no",
    date: "date",
    number: "number",
    text: "text",
  }[filter.valueType];
}

export function ColumnEntityMark({
  meta,
  className = "size-3.5",
}: {
  meta: ColumnIdentity | undefined;
  className?: string;
}) {
  const renderMark = useContext(ColumnMarkContext);
  const entity = columnEntityTarget(meta);
  return entity && renderMark ? renderMark(entity, className) : null;
}
