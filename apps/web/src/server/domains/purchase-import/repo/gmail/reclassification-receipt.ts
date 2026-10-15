import { emailReclassifyResult } from "@cubby/schemas/email-actions";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { email, emailClassificationObservation } from "~/server/db/schema";

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
