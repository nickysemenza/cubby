import { and, eq, sql } from "drizzle-orm";
import type { ActorContext } from "~/schemas/context";
import {
  type ActivityTypeId,
  type ProductId,
  unsafeActivityTypeId,
} from "~/schemas/identifiers";
import type { Database } from "~/server/db";
import { activityType } from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  formatSearchTerm,
  getDb,
  insertAndReturnDb,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";

// Output type with computed due status
export interface ActivityTypeWithStatus {
  id: string;
  productId: string;
  name: string;
  intervalDays: number | null;
  createdAt: Date;
  updatedAt: Date;
  lastCompletedAt: Date | null;
  nextDueAt: Date | null;
  isOverdue: boolean;
  isDueSoon: boolean; // within 14 days
  product: {
    id: string;
    name: string;
    shortcode: string;
  };
}

// Compute due status from activity type and latest entry
function computeDueStatus(
  intervalDays: number | null,
  lastCompletedAt: Date | null,
): { nextDueAt: Date | null; isOverdue: boolean; isDueSoon: boolean } {
  if (!intervalDays || !lastCompletedAt) {
    return { nextDueAt: null, isOverdue: false, isDueSoon: false };
  }

  const nextDueAt = new Date(lastCompletedAt);
  nextDueAt.setDate(nextDueAt.getDate() + intervalDays);

  const now = new Date();
  const fourteenDaysFromNow = new Date();
  fourteenDaysFromNow.setDate(fourteenDaysFromNow.getDate() + 14);

  return {
    nextDueAt,
    isOverdue: nextDueAt < now,
    isDueSoon: nextDueAt < fourteenDaysFromNow && nextDueAt >= now,
  };
}

// List activity types for a product with due status
export const listActivityTypesByProduct = async (
  db: Database,
  productId: ProductId,
): Promise<ActivityTypeWithStatus[]> => {
  const types = await getDb(db).query.activityType.findMany({
    where: eq(activityType.productId, productId),
    with: {
      product: {
        columns: { id: true, name: true, shortcode: true },
      },
      entries: {
        orderBy: (entries, { desc }) => [desc(entries.completedAt)],
        limit: 1,
      },
    },
    orderBy: (t, { asc }) => [asc(t.name)],
  });

  return types.map((t) => {
    const lastCompletedAt = t.entries[0]?.completedAt ?? null;
    const dueStatus = computeDueStatus(t.intervalDays, lastCompletedAt);

    return {
      id: t.id,
      productId: t.productId,
      name: t.name,
      intervalDays: t.intervalDays,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      lastCompletedAt,
      ...dueStatus,
      product: t.product,
    };
  });
};

// List all due/overdue activity types across all products
export const listDueActivityTypes = async (
  db: Database,
  options: { overdueOnly?: boolean; dueSoonDays?: number } = {},
): Promise<ActivityTypeWithStatus[]> => {
  const { overdueOnly = false, dueSoonDays = 14 } = options;

  // Get all activity types with intervals (scheduled ones)
  const types = await getDb(db).query.activityType.findMany({
    where: sql`${activityType.intervalDays} IS NOT NULL`,
    with: {
      product: {
        columns: { id: true, name: true, shortcode: true },
      },
      entries: {
        orderBy: (entries, { desc }) => [desc(entries.completedAt)],
        limit: 1,
      },
    },
  });

  const dueSoonDate = new Date();
  dueSoonDate.setDate(dueSoonDate.getDate() + dueSoonDays);

  return types
    .map((t) => {
      const lastCompletedAt = t.entries[0]?.completedAt ?? null;
      const dueStatus = computeDueStatus(t.intervalDays, lastCompletedAt);

      return {
        id: t.id,
        productId: t.productId,
        name: t.name,
        intervalDays: t.intervalDays,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        lastCompletedAt,
        ...dueStatus,
        product: t.product,
      };
    })
    .filter((t) => {
      if (!t.nextDueAt) return false;
      if (overdueOnly) return t.isOverdue;
      return t.nextDueAt < dueSoonDate; // due or overdue
    })
    .sort((a, b) => {
      // Sort by due date, overdue first
      if (!a.nextDueAt) return 1;
      if (!b.nextDueAt) return -1;
      return a.nextDueAt.getTime() - b.nextDueAt.getTime();
    });
};

// Autocomplete activity type names for a product
export const autocompleteActivityTypes = async (
  db: Database,
  productId: ProductId,
  query: string,
): Promise<Array<{ id: string; name: string }>> => {
  const types = await getDb(db).query.activityType.findMany({
    where: and(
      eq(activityType.productId, productId),
      formatSearchTerm(activityType.name, query),
    ),
    columns: { id: true, name: true },
    orderBy: (t, { asc }) => [asc(t.name)],
    limit: 10,
  });

  return types;
};

// Find by product and name (for upsert logic)
export const findActivityTypeByProductAndName = async (
  db: Database,
  productId: ProductId,
  name: string,
): Promise<{
  id: string;
  name: string;
  intervalDays: number | null;
} | null> => {
  const result = await getDb(db).query.activityType.findFirst({
    where: and(
      eq(activityType.productId, productId),
      eq(activityType.name, name),
    ),
    columns: { id: true, name: true, intervalDays: true },
  });

  return result ?? null;
};

// Create activity type
export const createActivityType = async (
  db: Database,
  data: {
    productId: ProductId;
    name: string;
    intervalDays?: number | null;
  },
  actorContext: ActorContext,
): Promise<{ id: string; name: string; intervalDays: number | null }> => {
  const result = await insertAndReturnDb(db, activityType, {
    productId: data.productId,
    name: data.name,
    intervalDays: data.intervalDays ?? null,
  });

  await logAuditEntry(db, actorContext, {
    entityType: "activity_type",
    entityId: unsafeActivityTypeId(result.id),
    action: "create",
  });

  return {
    id: result.id,
    name: result.name,
    intervalDays: result.intervalDays,
  };
};

// Update activity type
export const updateActivityType = async (
  db: Database,
  id: ActivityTypeId,
  data: { name?: string; intervalDays?: number | null },
  actorContext: ActorContext,
): Promise<{ id: string; name: string; intervalDays: number | null }> => {
  return withTransaction(db, async (tx) => {
    const existing = await tx.query.activityType.findFirst({
      where: eq(activityType.id, id),
    });

    if (!existing) {
      throw new Error(`Activity type ${id} not found`);
    }

    const result = await updateAndReturn(
      tx,
      activityType,
      {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.intervalDays !== undefined && {
          intervalDays: data.intervalDays,
        }),
      },
      eq(activityType.id, id),
    );

    await logAuditEntry(db, actorContext, {
      entityType: "activity_type",
      entityId: id,
      action: "update",
    });

    return {
      id: result.id,
      name: result.name,
      intervalDays: result.intervalDays,
    };
  });
};

// Delete activity type (cascades to entries)
export const deleteActivityType = async (
  db: Database,
  id: ActivityTypeId,
  actorContext: ActorContext,
): Promise<void> => {
  await getDb(db).delete(activityType).where(eq(activityType.id, id));

  await logAuditEntry(db, actorContext, {
    entityType: "activity_type",
    entityId: id,
    action: "delete",
  });
};
