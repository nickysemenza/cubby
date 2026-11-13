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
import type { z } from "zod";

import type { Database } from "~/server/db/database";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { decide, reconcileNow, recordSubject } from "~/server/kernel/api";

import { assignmentsInForce } from "./field-decisions";
import { fieldPlan } from "./plan";
import { readStoredColumns } from "./stored-field";

export async function applyFieldAuthorityAction(
  db: Database,
  actor: ActorContext,
  raw: z.input<typeof fieldAuthorityActionInput>,
): Promise<z.output<typeof fieldAuthorityActionOut>> {
  const input = fieldAuthorityActionInput.parse(raw);
  const plan = fieldPlan(input.entity, input.field);
  if (!plan)
    throw new Error(`${input.entity}.${input.field} is not a suggested field`);
  const recordId = await resolveLiveShortcode(db, input.id, input.entity);
  if (!recordId) throw new Error(`Record not found: ${input.id}`);
  const [held, stored] = await Promise.all([
    assignmentsInForce(db, plan.entity.entity, recordId, [input.field]),
    readStoredColumns(db, plan.entity, recordId, [input.field]),
  ]);
  const value = stored?.[input.field] ?? null;
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
