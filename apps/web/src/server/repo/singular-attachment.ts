/**
 * The one `cover` or `logo` attachment a cookbook or vendor may hold
 * (ADR 0006). These replaced the `Cookbook.coverImageId` and
 * `Vendor.logoImageId` columns; the partial unique index on
 * `(subjectEntityId, role)` keeps at most one live row per subject.
 */

import { and, eq, inArray } from "drizzle-orm";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import { entityAttachment } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";

export type SingularRole = "cover" | "logo";

const liveSingular = (subjectEntityId: string, role: SingularRole) =>
  and(
    eq(entityAttachment.subjectEntityId, subjectEntityId),
    eq(entityAttachment.role, role),
    notDeleted(entityAttachment),
  );

/** The live singular image id per subject. */
export async function singularAttachmentImageIds(
  db: Database | DrizzleClient | DrizzleTransaction,
  subjectEntityIds: readonly string[],
  role: SingularRole,
): Promise<Map<string, string>> {
  if (subjectEntityIds.length === 0) return new Map();
  const dbc = "select" in db ? db : unwrapDb(db);
  const rows = await dbc
    .select({
      subjectEntityId: entityAttachment.subjectEntityId,
      imageId: entityAttachment.imageId,
    })
    .from(entityAttachment)
    .where(
      and(
        inArray(entityAttachment.subjectEntityId, [...subjectEntityIds]),
        eq(entityAttachment.role, role),
        notDeleted(entityAttachment),
      ),
    );
  return new Map(rows.map((row) => [row.subjectEntityId, row.imageId]));
}

/**
 * Point a subject's singular slot at `imageId` (or clear it with `null`).
 * Returns the image the slot held before, so the caller can reap it once
 * nothing else references it.
 */
export async function replaceSingularAttachment(
  tx: DrizzleTransaction,
  subjectEntityId: string,
  role: SingularRole,
  imageId: string | null,
): Promise<{ previousImageId: string | null }> {
  const [previous] = await tx
    .select({ id: entityAttachment.id, imageId: entityAttachment.imageId })
    .from(entityAttachment)
    .where(liveSingular(subjectEntityId, role));
  if (previous?.imageId === imageId) return { previousImageId: null };
  if (previous) {
    await tx
      .update(entityAttachment)
      .set({ deletedAt: new Date() })
      .where(eq(entityAttachment.id, previous.id));
  }
  if (imageId !== null) {
    await tx
      .insert(entityAttachment)
      .values({ subjectEntityId, imageId, role, sortOrder: 0 });
  }
  return { previousImageId: previous?.imageId ?? null };
}
