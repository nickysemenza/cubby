/**
 * The one `cover` or `logo` attachment a cookbook or vendor may hold
 * (ADR 0006). These replaced the `Cookbook.coverImageId` and
 * `Vendor.logoImageId` columns; the partial unique index on
 * `(entityId, role)` keeps at most one live row per subject.
 */

import { and, eq, inArray } from "drizzle-orm";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import { entityAttachment } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";

export type SingularRole = "cover" | "logo";

/** The one kind whose declaration stores each singular role. */
const SINGULAR_ROLE_KIND = { cover: "cookbook", logo: "vendor" } as const;

const liveSingular = (entityId: string, role: SingularRole) =>
  and(
    eq(entityAttachment.entityId, entityId),
    eq(entityAttachment.role, role),
    notDeleted(entityAttachment),
  );

/** The live singular image id per subject. */
export async function singularAttachmentImageIds(
  db: Database | DrizzleClient | DrizzleTransaction,
  entityIds: readonly string[],
  role: SingularRole,
): Promise<Map<string, string>> {
  if (entityIds.length === 0) return new Map();
  const dbc = "select" in db ? db : unwrapDb(db);
  const rows = await dbc
    .select({
      entityId: entityAttachment.entityId,
      imageId: entityAttachment.imageId,
    })
    .from(entityAttachment)
    .where(
      and(
        inArray(entityAttachment.entityId, [...entityIds]),
        eq(entityAttachment.role, role),
        notDeleted(entityAttachment),
      ),
    );
  return new Map(rows.map((row) => [row.entityId, row.imageId]));
}

/**
 * Point a subject's singular slot at `imageId` (or clear it with `null`).
 * Returns the image the slot held before, so the caller can reap it once
 * nothing else references it.
 */
export async function replaceSingularAttachment(
  tx: DrizzleTransaction,
  entityId: string,
  role: SingularRole,
  imageId: string | null,
): Promise<{ previousImageId: string | null }> {
  const [previous] = await tx
    .select({ id: entityAttachment.id, imageId: entityAttachment.imageId })
    .from(entityAttachment)
    .where(liveSingular(entityId, role));
  if (previous?.imageId === imageId) return { previousImageId: null };
  if (previous) {
    await tx
      .update(entityAttachment)
      .set({ deletedAt: new Date() })
      .where(eq(entityAttachment.id, previous.id));
  }
  if (imageId !== null) {
    await tx.insert(entityAttachment).values({
      entityId,
      entityKind: SINGULAR_ROLE_KIND[role],
      imageId,
      role,
      sortOrder: 0,
    });
  }
  return { previousImageId: previous?.imageId ?? null };
}
