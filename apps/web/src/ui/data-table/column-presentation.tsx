import type { Entity } from "@cubby/schemas/entity";
import type { GeneratedListFieldPresentation } from "@cubby/schemas/entity-projection-types";
import { CalendarBlankIcon } from "@phosphor-icons/react/dist/csr/CalendarBlank";
import { CurrencyDollarIcon } from "@phosphor-icons/react/dist/csr/CurrencyDollar";
import { HashIcon } from "@phosphor-icons/react/dist/csr/Hash";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { LinkSimpleIcon } from "@phosphor-icons/react/dist/csr/LinkSimple";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { TextTIcon } from "@phosphor-icons/react/dist/csr/TextT";
import { ToggleLeftIcon } from "@phosphor-icons/react/dist/csr/ToggleLeft";
import { createContext, useContext, type ReactNode } from "react";

/** App composition supplies canonical marks without coupling shared UI to entities. */
export const ColumnMarkContext = createContext<
  ((entity: Entity, className: string) => ReactNode) | null
>(null);

import type { CubbyColumnMeta } from "./table-meta";

type ColumnIdentity = Pick<
  CubbyColumnMeta,
  "headerEntity" | "linksTo" | "countOf" | "presentation"
>;

/** Declaration-owned identity shared by headers and the column manager. */
export function columnEntityTarget(meta: ColumnIdentity | undefined) {
  return (
    meta?.presentation?.target ??
    meta?.headerEntity ??
    meta?.linksTo ??
    meta?.countOf
  );
}

export const listFieldTypeLabel = (
  field: Pick<GeneratedListFieldPresentation, "valueType" | "cardinality">,
) => {
  if (field.valueType === "record")
    return field.cardinality === "many" ? "records" : "record";
  return {
    text: "text",
    choice: "choice",
    boolean: "yes / no",
    date: "date",
    number: "number",
    money: "money",
    count: "count",
    structured: "structured",
    images: "images",
  }[field.valueType];
};

/** Type marks share the filter editor's visual vocabulary. */
export function ListFieldTypeMark({
  valueType,
  className = "size-3.5",
}: {
  valueType: GeneratedListFieldPresentation["valueType"];
  className?: string;
}) {
  const Icon = {
    record: LinkSimpleIcon,
    text: TextTIcon,
    choice: ListChecksIcon,
    boolean: ToggleLeftIcon,
    date: CalendarBlankIcon,
    number: HashIcon,
    money: CurrencyDollarIcon,
    count: HashIcon,
    structured: ListChecksIcon,
    images: ImageIcon,
  }[valueType];
  return <Icon className={className} aria-hidden="true" />;
}

/** Describe declared value semantics; missing metadata stays unspecified. */
export function columnTypeLabel(
  meta:
    | Pick<
        CubbyColumnMeta,
        | "headerEntity"
        | "linksTo"
        | "countOf"
        | "valueKind"
        | "filterConfig"
        | "presentation"
      >
    | undefined,
) {
  if (meta?.presentation) return listFieldTypeLabel(meta.presentation);
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
