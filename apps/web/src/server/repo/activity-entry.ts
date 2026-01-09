import { eq } from "drizzle-orm";
import type { ActorContext } from "~/schemas/context";
import {
  type ActivityEntryId,
  type ActivityTypeId,
  unsafeActivityEntryId,
} from "~/schemas/identifiers";
import type { PaginationParams } from "~/schemas/pagination";
import type { Database } from "~/server/db";
import { activityEntry, activityEntryImage } from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  getDb,
  insertAndReturnDb,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";

// Output type for activity entry
export interface ActivityEntryOut {
  id: string;
  activityTypeId: string;
  completedAt: Date;
  notes: string | null;
  createdAt: Date;
  images: Array<{
    id: string;
    url: string;
  }>;
}

// List entries for an activity type with pagination
export const listActivityEntries = async (
  db: Database,
  activityTypeId: ActivityTypeId,
  pagination: PaginationParams,
): Promise<{ items: ActivityEntryOut[]; total: number }> => {
  const query = getDb(db).query.activityEntry.findMany({
    where: eq(activityEntry.activityTypeId, activityTypeId),
    with: {
      images: {
        with: {
          image: {
            columns: { id: true, url: true },
          },
        },
      },
    },
    orderBy: (e, { desc }) => [desc(e.completedAt)],
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
  });

  const countQuery = getDb(db)
    .select({ count: activityEntry.id })
    .from(activityEntry)
    .where(eq(activityEntry.activityTypeId, activityTypeId));

  const [entries, countResult] = await Promise.all([query, countQuery]);

  return {
    items: entries.map((e) => ({
      id: e.id,
      activityTypeId: e.activityTypeId,
      completedAt: e.completedAt,
      notes: e.notes,
      createdAt: e.createdAt,
      images: e.images.map((i) => ({
        id: i.image.id,
        url: i.image.url,
      })),
    })),
    total: countResult.length,
  };
};

// Get latest entry for an activity type
export const getLatestEntryByType = async (
  db: Database,
  activityTypeId: ActivityTypeId,
): Promise<ActivityEntryOut | null> => {
  const entry = await getDb(db).query.activityEntry.findFirst({
    where: eq(activityEntry.activityTypeId, activityTypeId),
    with: {
      images: {
        with: {
          image: {
            columns: { id: true, url: true },
          },
        },
      },
    },
    orderBy: (e, { desc }) => [desc(e.completedAt)],
  });

  if (!entry) return null;

  return {
    id: entry.id,
    activityTypeId: entry.activityTypeId,
    completedAt: entry.completedAt,
    notes: entry.notes,
    createdAt: entry.createdAt,
    images: entry.images.map((i) => ({
      id: i.image.id,
      url: i.image.url,
    })),
  };
};

// Create activity entry
export const createActivityEntry = async (
  db: Database,
  data: {
    activityTypeId: ActivityTypeId;
    completedAt: Date;
    notes?: string | null;
    imageIds?: string[];
  },
  actorContext: ActorContext,
): Promise<ActivityEntryOut> => {
  return withTransaction(db, async (tx) => {
    const entry = await insertAndReturnDb(db, activityEntry, {
      activityTypeId: data.activityTypeId,
      completedAt: data.completedAt,
      notes: data.notes ?? null,
    });

    // Link images if provided
    if (data.imageIds && data.imageIds.length > 0) {
      await tx.insert(activityEntryImage).values(
        data.imageIds.map((imageId) => ({
          activityEntryId: entry.id,
          imageId,
        })),
      );
    }

    await logAuditEntry(db, actorContext, {
      entityType: "activity_entry",
      entityId: unsafeActivityEntryId(entry.id),
      action: "create",
    });

    // Fetch with images for return
    const result = await tx.query.activityEntry.findFirst({
      where: eq(activityEntry.id, entry.id),
      with: {
        images: {
          with: {
            image: {
              columns: { id: true, url: true },
            },
          },
        },
      },
    });

    return {
      id: result!.id,
      activityTypeId: result!.activityTypeId,
      completedAt: result!.completedAt,
      notes: result!.notes,
      createdAt: result!.createdAt,
      images: result!.images.map((i) => ({
        id: i.image.id,
        url: i.image.url,
      })),
    };
  });
};

// Update activity entry
export const updateActivityEntry = async (
  db: Database,
  id: ActivityEntryId,
  data: { completedAt?: Date; notes?: string | null },
  actorContext: ActorContext,
): Promise<ActivityEntryOut> => {
  return withTransaction(db, async (tx) => {
    const existing = await tx.query.activityEntry.findFirst({
      where: eq(activityEntry.id, id),
    });

    if (!existing) {
      throw new Error(`Activity entry ${id} not found`);
    }

    const _updated = await updateAndReturn(
      tx,
      activityEntry,
      {
        ...(data.completedAt !== undefined && {
          completedAt: data.completedAt,
        }),
        ...(data.notes !== undefined && { notes: data.notes }),
      },
      eq(activityEntry.id, id),
    );

    await logAuditEntry(db, actorContext, {
      entityType: "activity_entry",
      entityId: id,
      action: "update",
    });

    // Fetch with images for return
    const result = await tx.query.activityEntry.findFirst({
      where: eq(activityEntry.id, id),
      with: {
        images: {
          with: {
            image: {
              columns: { id: true, url: true },
            },
          },
        },
      },
    });

    return {
      id: result!.id,
      activityTypeId: result!.activityTypeId,
      completedAt: result!.completedAt,
      notes: result!.notes,
      createdAt: result!.createdAt,
      images: result!.images.map((i) => ({
        id: i.image.id,
        url: i.image.url,
      })),
    };
  });
};

// Delete activity entry
export const deleteActivityEntry = async (
  db: Database,
  id: ActivityEntryId,
  actorContext: ActorContext,
): Promise<void> => {
  await getDb(db).delete(activityEntry).where(eq(activityEntry.id, id));

  await logAuditEntry(db, actorContext, {
    entityType: "activity_entry",
    entityId: id,
    action: "delete",
  });
};
