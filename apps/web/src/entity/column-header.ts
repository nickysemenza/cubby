import type { Entity } from "@cubby/schemas/entity";
import type { EntityFieldModel } from "@cubby/schemas/entity-fields";

type ManifestField = EntityFieldModel["fields"][number];
type HeaderField = Pick<ManifestField, "label" | "kind" | "provenance"> & {
  display: Pick<ManifestField["display"], "format" | "columnLabel">;
};

const COUNT_FORMATS = new Set(["count", "arrayCount"]);

/** "expense" → "expenses", "category" → "categories", "branch" → "branches". */
function plural(noun: string) {
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(noun)) return `${noun}es`;
  return `${noun}s`;
}

/**
 * A table header's short form. A declared `display.columnLabel` wins; "X
 * count" reads as the plural "Xs"; anything else keeps its label. A number
 * counting one entity's records (a count format, or a label ending "count")
 * names that entity so its header can paint the entity's icon. The full
 * label stays the header's accessible name and tooltip.
 */
export function columnHeaderFor(field: HeaderField) {
  const count = /^(.+) count$/i.exec(field.label);
  const short =
    field.display.columnLabel ?? (count?.[1] ? plural(count[1]) : field.label);
  const sources = field.provenance?.sources ?? [];
  const counts =
    field.kind === "number" &&
    (count !== null ||
      (field.display.format !== null &&
        COUNT_FORMATS.has(field.display.format)));
  const countOf: Entity | null =
    counts && sources.length === 1 ? (sources[0]?.entity ?? null) : null;
  return { label: field.label, short, countOf };
}
