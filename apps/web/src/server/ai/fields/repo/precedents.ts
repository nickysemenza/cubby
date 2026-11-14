/**
 * Precedents (ADR 0028 item 5): values a person set for the same field on
 * records sharing a reference-valued basis key, corrections of Cubby first.
 * A person's value is one an assignment decision holds; Cubby's own values
 * are never precedents, so one wrong answer cannot teach the next. A
 * correction is a person's value on a record where they also ruled a value
 * out.
 */
import { decisionChannel, decisionKind } from "@cubby/schemas/kernel/stage";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { sqlEnumConstant } from "~/server/db/sql-enum";

/** Precedents one prompt carries. */
export const PRECEDENT_LIMIT = 8;
const LINE_LIMIT = 200;

export const precedentSchema = z.object({
  label: z.string().nullable(),
  value: z.json(),
  corrected: z.boolean(),
});
export type Precedent = z.infer<typeof precedentSchema>;

const ASSIGNMENT = sqlEnumConstant(decisionChannel, "assignment");
const VETO = sqlEnumConstant(decisionChannel, "veto");
const SET = sqlEnumConstant(decisionKind, "set");
const VETOED = sqlEnumConstant(decisionKind, "veto");

const subjectOf = (entity: string, id: SQL) =>
  sql`${`${entity}:`} || ${id}::text`;

/** The record `id` holds a person's value for `field`: its newest assignment is `set`. */
export const personHoldsSql = (entity: string, field: string, id: SQL) => sql`(
  SELECT d.kind FROM "Decision" d
  WHERE d.channel = ${ASSIGNMENT} AND d.subject = ${subjectOf(entity, id)} AND d.slot = ${field}
  ORDER BY d.at DESC, d.id DESC LIMIT 1) = ${SET}`;

/** A person ruled a value of `field` out on the record `id`. */
export const correctedSql = (
  entity: string,
  field: string,
  id: SQL,
) => sql`EXISTS (
  SELECT 1 FROM "Decision" v
  WHERE v.channel = ${VETO} AND v.subject = ${subjectOf(entity, id)}
    AND v.field = ${field} AND v.kind = ${VETOED})`;

/** The prompt's precedent lines; `labels` names reference values. */
export function precedentLines(
  precedents: readonly Precedent[],
  labels: ReadonlyMap<string, string>,
): string | null {
  if (!precedents.length) return null;
  return precedents
    .map((precedent) => {
      const raw =
        typeof precedent.value === "string"
          ? precedent.value
          : JSON.stringify(precedent.value);
      const value = labels.get(raw) ?? raw;
      const line = `- ${precedent.label ?? "Unnamed record"} -> ${value}${precedent.corrected ? " (a person corrected Cubby here)" : ""}`;
      return line.slice(0, LINE_LIMIT);
    })
    .join("\n");
}
