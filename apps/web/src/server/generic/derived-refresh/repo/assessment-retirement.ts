import { suggestionStatus } from "@cubby/schemas/ai";
import { suggestionSupersessionReceipt } from "@cubby/schemas/ai-evaluation";
import { assessmentFamily } from "@cubby/schemas/assessment";
import { DERIVED_REFRESH_PAGE } from "@cubby/schemas/derived-refresh";
import type { Entity } from "@cubby/schemas/entity-core";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { assessmentState, entityIdentity } from "~/server/db/schema";
import { productPairFingerprint } from "~/server/domains/product/repo/match/product-identity-snapshot";
import { fieldInputFingerprint } from "~/server/generic/assessment/repo/field-input-fence";

const fieldFence = z.object({ liveInputFingerprint: z.string() });
const pairFence = z.object({
  otherId: z.uuid(),
  source: z.string().optional(),
});

function retirementCandidatesWhere(
  subject: Parameters<typeof prepareAssessmentRetirement>[1],
) {
  const fields = entityFieldModels[subject.entityKind].fields.map(
    (field) => field.key,
  );
  return and(
    eq(assessmentState.active, true),
    sql`((${assessmentState.family}=${assessmentFamily.enum.field} AND ${assessmentState.status}=${suggestionStatus.enum.pending}
      AND ${assessmentState.entity}=${subject.entityKind} AND ${assessmentState.recordId}=${subject.entityId}::uuid
      AND ${assessmentState.field}=ANY(ARRAY[${sql.join(
        fields.map((field) => sql`${field}`),
        sql`, `,
      )}]::text[]))
      OR (${subject.entityKind === "product"} AND ${assessmentState.family}=${assessmentFamily.enum.product_pair}
        AND (${assessmentState.recordId}=${subject.entityId}::uuid OR ${assessmentState.data}->>'otherId'=${subject.entityId})))`,
    subject.after ? gt(assessmentState.id, subject.after) : undefined,
  );
}

/** An absence proof may share the projection fence; existing candidates may not. */
export async function hasAssessmentRetirementCandidates(
  db: Database,
  subject: Pick<
    Parameters<typeof prepareAssessmentRetirement>[1],
    "entityKind" | "entityId"
  >,
) {
  const [candidate] = await getDb(db)
    .select({ id: assessmentState.id })
    .from(assessmentState)
    .where(retirementCandidatesWhere({ ...subject, after: null }))
    .limit(1);
  return candidate !== undefined;
}

/** Prepare against current inputs; a delayed wave preserves current judgments. */
export async function prepareAssessmentRetirement(
  db: Database,
  subject: { entityKind: Entity; entityId: string; after: string | null },
) {
  const candidates = await getDb(db)
    .select()
    .from(assessmentState)
    .where(retirementCandidatesWhere(subject))
    .orderBy(asc(assessmentState.id))
    .limit(DERIVED_REFRESH_PAGE);
  const [live] = await getDb(db)
    .select({ deletedAt: entityIdentity.deletedAt })
    .from(entityIdentity)
    .where(eq(entityIdentity.id, subject.entityId))
    .limit(1);
  const deleted = !live || live.deletedAt !== null;
  const fingerprints = new Map<string, string>();
  const targets: typeof candidates = [];
  for (const row of candidates) {
    if (row.family === "field") {
      if (deleted) {
        targets.push(row);
        continue;
      }
      const stored = fieldFence.safeParse(row.data);
      if (!stored.success || !row.field) {
        targets.push(row);
        continue;
      }
      let current = fingerprints.get(row.field);
      if (!current) {
        current = await fieldInputFingerprint(
          db,
          subject.entityKind,
          subject.entityId,
          row.field,
        );
        fingerprints.set(row.field, current);
      }
      if (stored.data.liveInputFingerprint !== current) targets.push(row);
    } else {
      const pair = pairFence.parse(row.data);
      if (pair.source === "agent" && !deleted) continue;
      const fingerprint = deleted
        ? null
        : await productPairFingerprint(db, [
            parseEntityId("product", row.recordId),
            parseEntityId("product", pair.otherId),
          ]);
      if (fingerprint === null || fingerprint !== row.fingerprint)
        targets.push(row);
    }
  }
  return {
    targets,
    after: candidates.at(-1)?.id ?? subject.after,
    done: candidates.length < DERIVED_REFRESH_PAGE,
  };
}

/** Status and basis are rechecked in the UPDATE after any row-lock wait. */
export async function publishAssessmentRetirement(
  db: Database,
  prepared: Awaited<ReturnType<typeof prepareAssessmentRetirement>>,
) {
  if (prepared.targets.length === 0) return;
  const values = sql.join(
    prepared.targets.map(
      (row) => sql`(${row.id}::uuid, ${row.status}::text,
    ${JSON.stringify(row.data)}::jsonb, ${row.fingerprint}::text)`,
    ),
    sql`, `,
  );
  await getDb(db).execute(sql`
    UPDATE "AssessmentState" s SET status=${suggestionStatus.enum.superseded}, "updatedAt"=now(),
      "supersessionReceipt"=jsonb_build_object('reason',${suggestionSupersessionReceipt.shape.reason.enum.input_changed}::text,'evaluationId',NULL,'at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    FROM (VALUES ${values}) v(id,status,data,fingerprint)
    WHERE s.id=v.id AND s.active AND s.status=v.status AND s.data IS NOT DISTINCT FROM v.data
      AND s.fingerprint IS NOT DISTINCT FROM v.fingerprint
  `);
}
