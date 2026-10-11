import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type { ReportRecordRow } from "@cubby/schemas/entity-report";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entities } from "~/entity/entities";
import { ShortcodeProse } from "~/ui/shortcode-prose";

/** A row's declared entity, when the browser has a detail route for it. */
export const routedEntity = (
  entity: string | null,
): BrowserRoutedEntity | null => {
  if (entity === null || !Object.hasOwn(entities, entity)) return null;
  // SAFETY: `entities` is keyed by exactly the browser-routed entities.
  return entity as BrowserRoutedEntity;
};

export function RowTitle({ row }: { row: ReportRecordRow }) {
  const entity = routedEntity(row.entity);
  if (entity !== null && row.id !== null)
    return (
      <EntityRefLink
        variant="chip"
        entity={entity}
        id={row.id}
        name={row.title}
        displayImage={null}
      />
    );
  if (row.title === "") return null;
  return (
    <span className="font-medium whitespace-pre-line">
      <ShortcodeProse>{row.title}</ShortcodeProse>
    </span>
  );
}

export const TONE_TEXT = {
  positive: "text-positive",
  warning: "text-warning-ink",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
} as const;
export const STATUS_VARIANT = {
  positive: "positive",
  warning: "warning",
  destructive: "destructive",
  muted: "outline",
} as const;

/** Stable keys for rows that may repeat (a recipe appears once per section it uses). */
export const rowKeys = (rows: readonly ReportRecordRow[]) => {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    if (row.key !== undefined && row.commands !== undefined) return row.key;
    const base = `${row.entity ?? ""}:${row.id ?? ""}:${row.title}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return `${base}#${occurrence}`;
  });
};
