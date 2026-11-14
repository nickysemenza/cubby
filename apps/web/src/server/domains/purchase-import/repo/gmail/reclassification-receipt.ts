import { emailReclassifyResult } from "@cubby/schemas/email-actions";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import {
  email,
  emailClassificationObservation,
} from "~/server/db/retained-tables";

/** Read inside the publication transaction: an observation alone is never a receipt. */
export async function reclassificationReceipt(
  db: Database,
  before: typeof email.$inferSelect,
  observationId: string | null,
  publication: unknown,
  removed = false,
) {
  const [[observed], [after]] = await Promise.all([
    getDb(db)
      .select()
      .from(emailClassificationObservation)
      .where(
        eq(
          emailClassificationObservation.id,
          observationId ?? "00000000-0000-0000-0000-000000000000",
        ),
      )
      .limit(1),
    getDb(db).select().from(email).where(eq(email.id, before.id)).limit(1),
  ]);
  const result = z
    .object({
      kind: z.string(),
      reason: z.enum(["resolution_kept", "awaiting_acceptance"]).optional(),
    })
    .safeParse(publication);
  const outcome = removed
    ? "removed"
    : result.success && result.data.kind === "kept"
      ? (result.data.reason ?? "resolution_kept")
      : after?.classification === before.classification
        ? "confirmed"
        : "replaced";
  return {
    result: emailReclassifyResult.parse({
      id: before.shortcode,
      outcome,
      classification: observed?.classification ?? null,
      stage: observed?.stage ?? null,
      conflict: observed?.conflict?.kind === "member_review",
      error: null,
    }),
    observationId: observed?.id ?? null,
    sourceChecksum: after?.checksum ?? before.checksum,
  };
}

/** The publication receipt commits with the source write, ahead of the Run checkpoint. */
export async function saveReclassificationReceipt(
  db: Database,
  runId: string,
  before: typeof email.$inferSelect,
  receipt: ReturnType<typeof reclassificationReceipt> extends Promise<infer R>
    ? R
    : never,
) {
  const { mailHandlingReceipt } = await import("~/server/db/retained-tables");
  const { sql } = await import("drizzle-orm");
  await getDb(db)
    .insert(mailHandlingReceipt)
    .values({
      runId,
      emailId: before.id,
      key: `${runId}:reclassification:${before.id}:${before.checksum}`,
      receipt: z.json().parse(receipt),
    })
    .onConflictDoNothing();
  await getDb(db)
    .execute(sql`UPDATE "AskScope" s SET receipt=${JSON.stringify(receipt)}::jsonb
    WHERE s."runId"=${runId}::uuid AND EXISTS (SELECT 1 FROM "AskScope" record
      WHERE record."askId"=s."askId" AND record."scopeKind"=${"record"} AND record."scopeKey"=${`email:${before.id}`})`);
}

/** Durable per-source publication receipts, independent of a Run checkpoint. */
export async function readReclassificationReceipts(
  db: Database,
  runId: string,
) {
  const { mailHandlingReceipt } = await import("~/server/db/retained-tables");
  const rows = await getDb(db)
    .select()
    .from(mailHandlingReceipt)
    .where(eq(mailHandlingReceipt.runId, runId));
  return rows.flatMap((row) => {
    if (!row.key.startsWith(`${runId}:reclassification:`)) return [];
    const parsed = z
      .object({ result: emailReclassifyResult })
      .safeParse(row.receipt);
    return parsed.success
      ? [{ emailId: row.emailId, key: row.key, result: parsed.data.result }]
      : [];
  });
}
