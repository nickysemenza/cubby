/**
 * Keep, "Wrong, clear it" and "Let Cubby decide" (ADR 0028 item 4) as
 * decisions. Keep records the shown value as the member's assignment; Wrong
 * vetoes Cubby's value, which the `fields` scope then clears and never
 * applies again; Let Cubby decide releases a person's assignment.
 */
import type { ActorContext } from "@cubby/schemas/context";
import {
  fieldAuthorityActionInput,
  type fieldAuthorityActionOut,
} from "@cubby/schemas/field-authority";
import { undecidedFieldValue } from "@cubby/schemas/field-suggestion-policy";
import { FIELDS_SCOPE, recordScopeKey } from "@cubby/schemas/kernel/capability";
import { sql } from "drizzle-orm";
import type { z } from "zod";

import { fieldJson, valueKey } from "~/server/ai/policy/field-rules";
import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { decodeAuditCursor } from "~/server/generic/audit-log/repo/audit-log";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { recordSubject } from "~/server/kernel/keys";

import { assignmentsInForce } from "./field-decisions";
import { fieldPlan } from "./plan";
import { readStoredRows } from "./stored-field";

export async function applyFieldAuthorityAction(
  db: Database,
  actor: ActorContext,
  raw: z.input<typeof fieldAuthorityActionInput>,
): Promise<z.output<typeof fieldAuthorityActionOut>> {
  const { decide, reconcileNow } = await import("~/server/kernel/api");
  const input = fieldAuthorityActionInput.parse(raw);
  const plan = fieldPlan(input.entity, input.field);
  if (!plan)
    throw new Error(`${input.entity}.${input.field} is not a suggested field`);
  const recordId = await resolveLiveShortcode(db, input.id, input.entity);
  if (!recordId) throw new Error(`Record not found: ${input.id}`);
  const [held, storedRows] = await Promise.all([
    assignmentsInForce(db, plan.entity.entity, recordId, [input.field]),
    readStoredRows(db, plan.entity, [recordId], [input.field]),
  ]);
  const stored = storedRows.get(recordId);
  const value = stored?.[input.field] ?? null;
  if (input.suggestionId) {
    const cursor = decodeAuditCursor(input.suggestionId);
    const audited = await repositoryQueries(db).execute<{ value: unknown }>(sql`
      SELECT changes->${input.field}->'to' AS value FROM "AuditLog"
      WHERE id=${cursor.id}::uuid AND "entityKind"=${input.entity} AND "entityId"=${recordId}::uuid
        AND provenance->${"scope"}->>${"kind"}=${"fields"}`);
    if (
      !audited.rows.length ||
      valueKey(audited.rows[0]!.value) !== valueKey(fieldJson(value))
    )
      throw new Error("Cubby has revised this value since this change");
  }
  const empty = undecidedFieldValue(input.entity, input.field, value);
  const subject = recordSubject(input.entity, recordId);
  const scope = {
    kind: FIELDS_SCOPE,
    key: recordScopeKey(input.entity, recordId),
  };
  if (input.action === "release") {
    if (!held.has(input.field))
      throw new Error("Only a person's value can be handed to Cubby");
    if (plan.field.apply !== "auto")
      throw new Error("Cubby does not decide this field on its own");
    if (plan.field.fillOnly)
      throw new Error("Cubby only fills this field; it never revises it");
    await decide(db, actor, [
      { channel: "assignment", kind: "release", subject, field: input.field },
    ]);
    await reconcileNow(db, [scope], { waitMs: 2_000 });
    return { holder: empty ? "open" : "cubby" };
  }
  if (held.has(input.field)) throw new Error("This value was not set by Cubby");
  if (empty) throw new Error("This field holds no value");
  if (input.action === "keep") {
    await decide(db, actor, [
      {
        channel: "assignment",
        kind: "set",
        subject,
        field: input.field,
        // SAFETY: fill fields store scalars.
        value: value as string,
      },
    ]);
    return { holder: "person" };
  }
  // SAFETY: as above.
  await decide(db, actor, [
    { channel: "assignment", kind: "release", subject, field: input.field },
    {
      channel: "veto",
      kind: "veto",
      subject,
      field: input.field,
      value: value as string,
    },
  ]);
  await reconcileNow(db, [scope], { waitMs: 2_000 });
  return { holder: "open" };
}
