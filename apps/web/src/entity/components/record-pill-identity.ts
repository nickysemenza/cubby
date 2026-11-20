import type { Entity } from "@cubby/schemas/entity";
import { entityRoster } from "@cubby/schemas/entity-roster";
import { z } from "zod";

import { readRecordField } from "~/entity/entity-references";
import { formatCalendarDay, formatInstant } from "~/lib/date-format";
import { formatCurrency } from "~/lib/number-format";
import type { RecordPillFact } from "~/ui/records/record-pill";

const factValue = z
  .union([
    z.number(),
    z.string(),
    // A date range is told by the day it starts.
    z.looseObject({ start: z.string() }).transform((range) => range.start),
  ])
  .nullish()
  .catch(null);

const text = z.string().nullish().catch(null);

/** A row a reference came from: plain values or canonical field envelopes. */
export type ReferenceRecord = z.infer<typeof referenceRecord>;
const referenceRecord = z.looseObject({});

/** The mono prefix a mixed list shows: "EXP" for `EXP-`. */
export const recordTypeCode = (entity: Entity): string | null =>
  entityRoster[entity].shortcodePrefix?.replace(/-$/, "") ?? null;

/**
 * The entity's declared fact, read off whatever the reference already holds.
 * A record that does not carry the field has no fact; nothing is fetched here.
 */
export function recordFact(
  entity: Entity,
  record: ReferenceRecord,
): RecordPillFact | null {
  const declared = entityRoster[entity].recordFact;
  if (!declared) return null;
  const value = readRecordField(record, declared.field, factValue);
  if (value == null || value === "") return null;
  if (declared.format === "currency")
    return typeof value === "number"
      ? { text: formatCurrency(value), negative: value < 0 }
      : null;
  if (typeof value === "number") return null;
  return {
    text:
      declared.format === "date"
        ? formatCalendarDay(value, "dateShort")
        : formatInstant(value, "dateShort"),
  };
}

/** The value of the entity's declared qualifier field, when the record has it. */
export const recordQualifier = (
  entity: Entity,
  record: ReferenceRecord,
): string | null => {
  const field = entityRoster[entity].recordQualifierField;
  return field ? (readRecordField(record, field, text) ?? null) : null;
};

/**
 * A title that repeats its qualifier ("Northwind Air round-trip") reads as
 * the part that differs ("Round-trip"), with the shared part left to the mark
 * and the muted qualifier. A title that is only the qualifier is kept whole.
 */
export function titleWithoutQualifier(
  title: string,
  qualifier: string | null,
): string {
  if (!qualifier) return title;
  if (!title.toLowerCase().startsWith(qualifier.toLowerCase())) return title;
  const rest = title.slice(qualifier.length).replace(/^[\s:,·–—-]+/, "");
  if (!rest) return title;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}
