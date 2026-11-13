/** Authored field Decisions use the same entity writer as an ordinary edit. */
import { parseEntityRef } from "@cubby/schemas/identifiers";

import { fieldReviewPlan } from "~/server/ai/fields/repo/plan";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import type { DecisionWriters } from "~/server/kernel/decide";

export const authoredFieldWriter =
  (context: EntityKernelContext): NonNullable<DecisionWriters["field"]> =>
  async (db, decision) => {
    const match = /^([A-Za-z][\w-]*):([0-9a-f-]{36})$/u.exec(decision.subject);
    if (!match || !decision.field) return;
    const target = fieldReviewPlan(match[1]!, decision.field);
    if (!target) throw new Error("The field has no authored writer");
    const codes = await lookupShortcodes(db, [
      parseEntityRef(target.entity.entity, match[2]!),
    ]);
    let value = decision.kind === "set" ? decision.value : null;
    if (target.field.reference && typeof value === "string") {
      const refs = await lookupShortcodes(db, [
        parseEntityRef(target.field.reference, value),
      ]);
      value = refs.get(`${target.field.reference}:${value}`) ?? value;
    }
    await executeEntity(
      { ...context, db },
      entityCommandSchema.parse({
        action: "update",
        entity: target.entity.entity,
        id: codes.get(`${target.entity.entity}:${match[2]!}`),
        data: { [decision.field]: value },
      }),
    );
  };
