import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import {
  assessmentCorrectionLock,
  assessment,
  assessmentState,
} from "~/server/db/schema";
import { fieldCorrectionIdentityReader } from "~/server/generic/assessment/repo/correction-sources";

/** Replacement and member review share key-before-record/projection ordering. */
export async function lockFieldCorrectionKeysForField(
  db: Database,
  input: {
    entity: string;
    recordId: string;
    field: string;
    keys: readonly (string | null)[];
  },
) {
  const prior = await getDb(db)
    .select({ evidence: assessment.evidence })
    .from(assessment)
    .innerJoin(assessmentState, eq(assessmentState.id, assessment.id))
    .where(
      and(
        eq(assessmentState.entity, input.entity),
        eq(assessmentState.recordId, input.recordId),
        eq(assessmentState.field, input.field),
      ),
    );
  const keys = new Set(input.keys);
  const readIdentity = fieldCorrectionIdentityReader(db);
  for (const row of prior) {
    const identity = await readIdentity(input, row.evidence);
    keys.add(identity.storedKey);
    keys.add(identity.canonicalKey);
  }
  for (const key of [...keys].filter((key) => key !== null).sort())
    await lockFieldCorrectionKey(db, key);
}

/** Must run inside the caller's write transaction, before source/target row locks. */
export async function lockFieldCorrectionKey(db: Database, key: string) {
  // A physical update is intentional: a lock alone cannot invalidate an older
  // serializable snapshot when a conflicting root commits on another record.
  await getDb(db)
    .insert(assessmentCorrectionLock)
    .values({ key })
    .onConflictDoUpdate({ target: assessmentCorrectionLock.key, set: { key } });
}
