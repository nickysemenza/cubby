import { auditEntitySchema } from "@cubby/schemas/audit";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import {
  fieldAuthorityActionInput,
  type fieldAuthorityActionOut,
} from "@cubby/schemas/field-authority";
import {
  financeReviewContext,
  suggestApplyPolicy,
} from "@cubby/schemas/field-suggestion-policy";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { fieldAuthority } from "~/server/generic/suggestions/repo/field-authority";
import { recordFeedback } from "~/server/generic/suggestions/repo/suggestion";
import { transitionSuggestionState } from "~/server/generic/suggestions/repo/suggestion-state";

/** Keep, Wrong-and-clear and Let Cubby decide: the member's controls over field authority. */
export async function applyFieldAuthorityAction(
  db: Database,
  context: EntityKernelContext,
  raw: z.input<typeof fieldAuthorityActionInput>,
): Promise<z.output<typeof fieldAuthorityActionOut>> {
  const input = fieldAuthorityActionInput.parse(raw);
  const policy = entityFieldByKey(input.entity, input.field)?.control?.suggest;
  if (!policy || policy.mode !== "fill")
    throw new Error(`${input.entity}.${input.field} is not a suggested field`);
  return withTransactionDatabase(db, async (tx) => {
    const recordId = await resolveLiveShortcode(tx, input.id, input.entity);
    if (!recordId) throw new Error(`Record not found: ${input.id}`);
    // Serialize with the automatic gate, which reads the same audit trail.
    await getDb(tx).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`field-authority:${input.entity}:${recordId}:${input.field}`},0))`,
    );
    const authority = await fieldAuthority(
      tx,
      input.entity,
      recordId,
      input.field,
    );
    const member = context.actorContext;
    if (input.action === "release") {
      if (authority.holder !== "person")
        throw new Error("Only a person's value can be handed to Cubby");
      if (suggestApplyPolicy(input.entity, input.field) !== "auto")
        throw new Error("Cubby does not decide this field on its own");
      const table = SHORTCODE_TABLE[input.entity];
      const [row] = await getDb(tx).execute<{ value: unknown }>(
        sql`SELECT to_jsonb(t)->${input.field} AS value FROM ${table} t WHERE t.id = ${recordId}::uuid`,
        "objects",
      );
      const value = row?.value ?? null;
      // An unchanged value with the released authority: the field is Cubby's again.
      await logAuditEntry(
        tx,
        { ...member, authority: "released" },
        {
          entityKind: auditEntitySchema.parse(input.entity),
          entityId: recordId,
          action: "update",
          changes: { [input.field]: { from: value, to: value } },
        },
      );
      return { holder: value == null || value === "" ? "open" : "cubby" };
    }
    if (authority.holder !== "cubby" || !authority.suggestionId)
      throw new Error("This value was not set by Cubby");
    const suggestionId = authority.suggestionId;
    if (input.action === "keep") {
      await recordFeedback(tx, {
        suggestionId,
        operationId: `keep:${suggestionId}`,
        verdict: "correct",
        authority: "member",
        actorUserId: member.userId,
        intent: "history",
      });
      return { holder: "person" };
    }
    if (financeReviewContext(input.entity, input.field))
      throw new Error("Clear this spending field from its editor");
    await recordFeedback(tx, {
      suggestionId,
      operationId: `clear:${suggestionId}`,
      verdict: "wrong",
      authority: "member",
      actorUserId: member.userId,
      intent: "history",
    });
    await transitionSuggestionState(tx, suggestionId, { status: "rejected" });
    // Released: the member cleared a wrong value without choosing one, so
    // Cubby may fill the field again, never with the rejected value.
    await executeEntity(
      {
        ...context,
        db: tx,
        actorContext: { ...member, authority: "released" },
      },
      entityCommandSchema.parse({
        action: "update",
        entity: input.entity,
        id: input.id,
        data: { [input.field]: null },
      }),
    );
    return { holder: "open" };
  });
}
