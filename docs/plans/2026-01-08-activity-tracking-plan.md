# Activity Tracking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Track recurring and ad-hoc activities performed on products (maintenance, cleaning, inspections) with due date tracking and Google Sheets sync.

**Architecture:** Two new tables (activity_type, activity_entry) linked to products. Activity types define what can be done to a product with optional recurrence interval. Entries log when activities were completed. Problems dashboard shows overdue items.

**Tech Stack:** Drizzle ORM, tRPC, React Query, TanStack Router, Google Sheets API (existing client)

---

## Task 1: Add Branded ID Types

**Files:**
- Modify: `apps/web/src/schemas/identifiers.ts`

**Step 1: Add activity branded types**

Add after line 13 (after `inventoryId`):

```typescript
export const activityTypeId = z.uuid().brand("ActivityTypeId");
export const activityEntryId = z.uuid().brand("ActivityEntryId");
```

**Step 2: Add type exports**

Add after line 44 (after `RecipeShortcode` type):

```typescript
export type ActivityTypeId = z.infer<typeof activityTypeId>;
export type ActivityEntryId = z.infer<typeof activityEntryId>;
```

**Step 3: Add unsafe converters**

Add after line 61 (after `unsafeRecipeShortcode`):

```typescript
export const unsafeActivityTypeId = (id: string) =>
  unsafeId<ActivityTypeId>(id);
export const unsafeActivityEntryId = (id: string) =>
  unsafeId<ActivityEntryId>(id);
```

**Step 4: Verify types compile**

Run: `pnpm run check`
Expected: PASS (no type errors)

**Step 5: Commit**

```bash
git add apps/web/src/schemas/identifiers.ts
git commit -m "feat(activity): add branded ActivityTypeId and ActivityEntryId types"
```

---

## Task 2: Add Database Schema

**Files:**
- Modify: `apps/web/src/server/db/schema.ts`

**Step 1: Add activity_type table**

Add after `appSettings` table (around line 580):

```typescript
// Activity Type table - defines activities that can be performed on products
export const activityType = pgTable(
  "ActivityType",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    productId: uuid("productId")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    intervalDays: integer("intervalDays"), // null = event-based (no schedule)
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    productNameUnique: uniqueIndex("ActivityType_productId_name_key").on(
      table.productId,
      table.name,
    ),
    productIdIdx: index("ActivityType_productId_idx").on(table.productId),
  }),
);

// Activity Entry table - logs when activities were completed
export const activityEntry = pgTable(
  "ActivityEntry",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    activityTypeId: uuid("activityTypeId")
      .notNull()
      .references(() => activityType.id, { onDelete: "cascade" }),
    completedAt: timestamp("completedAt", { mode: "date" }).notNull(),
    notes: text("notes"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    activityTypeIdIdx: index("ActivityEntry_activityTypeId_idx").on(
      table.activityTypeId,
    ),
    completedAtIdx: index("ActivityEntry_completedAt_idx").on(
      table.completedAt.desc(),
    ),
  }),
);

// Activity Entry Image join table
export const activityEntryImage = pgTable(
  "ActivityEntryImage",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    activityEntryId: uuid("activityEntryId")
      .notNull()
      .references(() => activityEntry.id, { onDelete: "cascade" }),
    imageId: uuid("imageId")
      .notNull()
      .references(() => image.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    entryImageUnique: uniqueIndex(
      "ActivityEntryImage_activityEntryId_imageId_key",
    ).on(table.activityEntryId, table.imageId),
    activityEntryIdIdx: index("ActivityEntryImage_activityEntryId_idx").on(
      table.activityEntryId,
    ),
    imageIdIdx: index("ActivityEntryImage_imageId_idx").on(table.imageId),
  }),
);
```

**Step 2: Add relations**

Add after existing relations (after `recipeImageRelations`):

```typescript
// Activity relations
export const activityTypeRelations = relations(activityType, ({ one, many }) => ({
  product: one(product, {
    fields: [activityType.productId],
    references: [product.id],
  }),
  entries: many(activityEntry),
}));

export const activityEntryRelations = relations(activityEntry, ({ one, many }) => ({
  activityType: one(activityType, {
    fields: [activityEntry.activityTypeId],
    references: [activityType.id],
  }),
  images: many(activityEntryImage),
}));

export const activityEntryImageRelations = relations(
  activityEntryImage,
  ({ one }) => ({
    activityEntry: one(activityEntry, {
      fields: [activityEntryImage.activityEntryId],
      references: [activityEntry.id],
    }),
    image: one(image, {
      fields: [activityEntryImage.imageId],
      references: [image.id],
    }),
  }),
);
```

**Step 3: Add to product relations**

Find `productRelations` and add `activityTypes: many(activityType),` to the return object.

**Step 4: Verify schema compiles**

Run: `pnpm run check`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/web/src/server/db/schema.ts
git commit -m "feat(activity): add ActivityType, ActivityEntry, ActivityEntryImage schema"
```

---

## Task 3: Generate and Run Migration

**Files:**
- Create: `apps/web/drizzle/0010_add_activities.sql`

**Step 1: Generate migration**

Run: `cd apps/web && pnpm drizzle-kit generate`

**Step 2: Review generated SQL**

The generated migration should create:
- `ActivityType` table with productId FK, name, intervalDays
- `ActivityEntry` table with activityTypeId FK, completedAt, notes
- `ActivityEntryImage` join table
- Appropriate indexes

**Step 3: Run migration against dev database**

Run: `cd apps/web && pnpm drizzle-kit push`
Expected: Tables created successfully

**Step 4: Commit migration**

```bash
git add apps/web/drizzle/
git commit -m "chore(db): add activity tables migration"
```

---

## Task 4: Add Query Keys

**Files:**
- Modify: `apps/web/src/lib/query-keys.ts`

**Step 1: Add activity query keys**

Add after `recipe` object:

```typescript
  activityType: {
    list: ["activityType", "list"] as const,
    listDue: ["activityType", "listDue"] as const,
    byProduct: ["activityType", "byProduct"] as const,
    autocomplete: ["activityType", "autocomplete"] as const,
  },
  activityEntry: {
    list: ["activityEntry", "list"] as const,
  },
```

**Step 2: Verify compiles**

Run: `pnpm run check`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/web/src/lib/query-keys.ts
git commit -m "feat(activity): add query keys for activity types and entries"
```

---

## Task 5: Create Activity Type Repository

**Files:**
- Create: `apps/web/src/server/repo/activity-type.ts`

**Step 1: Create the repository file**

```typescript
import { and, eq, isNull, sql } from "drizzle-orm";
import type { ActorContext } from "~/schemas/context";
import {
  type ActivityTypeId,
  type ProductId,
  unsafeActivityTypeId,
} from "~/schemas/identifiers";
import type { Database } from "~/server/db";
import { activityEntry, activityType, product } from "~/server/db/schema";
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

  const now = new Date();
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
): Promise<{ id: string; name: string; intervalDays: number | null } | null> => {
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

  await logAuditEntry(
    db,
    "activity_type",
    unsafeActivityTypeId(result.id),
    "create",
    null,
    actorContext,
  );

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

    await logAuditEntry(
      db,
      "activity_type",
      id,
      "update",
      { from: existing, to: result },
      actorContext,
    );

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

  await logAuditEntry(db, "activity_type", id, "delete", null, actorContext);
};
```

**Step 2: Verify compiles**

Run: `pnpm run check`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/web/src/server/repo/activity-type.ts
git commit -m "feat(activity): add activity type repository"
```

---

## Task 6: Create Activity Entry Repository

**Files:**
- Create: `apps/web/src/server/repo/activity-entry.ts`

**Step 1: Create the repository file**

```typescript
import { eq } from "drizzle-orm";
import type { ActorContext } from "~/schemas/context";
import {
  type ActivityEntryId,
  type ActivityTypeId,
  unsafeActivityEntryId,
} from "~/schemas/identifiers";
import type { PaginationParams } from "~/schemas/pagination";
import type { Database } from "~/server/db";
import {
  activityEntry,
  activityEntryImage,
  image,
} from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  executeListQueryWithCount,
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
    offset: (pagination.page - 1) * pagination.pageSize,
  });

  const countQuery = getDb(db)
    .select({ count: eq(activityEntry.activityTypeId, activityTypeId) })
    .from(activityEntry)
    .where(eq(activityEntry.activityTypeId, activityTypeId));

  const [entries, countResult] = await Promise.all([
    query,
    getDb(db)
      .select({ count: activityEntry.id })
      .from(activityEntry)
      .where(eq(activityEntry.activityTypeId, activityTypeId)),
  ]);

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
    const entry = await insertAndReturnDb(
      db,
      activityEntry,
      {
        activityTypeId: data.activityTypeId,
        completedAt: data.completedAt,
        notes: data.notes ?? null,
      },
    );

    // Link images if provided
    if (data.imageIds && data.imageIds.length > 0) {
      await tx.insert(activityEntryImage).values(
        data.imageIds.map((imageId) => ({
          activityEntryId: entry.id,
          imageId,
        })),
      );
    }

    await logAuditEntry(
      db,
      "activity_entry",
      unsafeActivityEntryId(entry.id),
      "create",
      null,
      actorContext,
    );

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

    const updated = await updateAndReturn(
      tx,
      activityEntry,
      {
        ...(data.completedAt !== undefined && { completedAt: data.completedAt }),
        ...(data.notes !== undefined && { notes: data.notes }),
      },
      eq(activityEntry.id, id),
    );

    await logAuditEntry(
      db,
      "activity_entry",
      id,
      "update",
      { from: existing, to: updated },
      actorContext,
    );

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

  await logAuditEntry(db, "activity_entry", id, "delete", null, actorContext);
};
```

**Step 2: Verify compiles**

Run: `pnpm run check`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/web/src/server/repo/activity-entry.ts
git commit -m "feat(activity): add activity entry repository"
```

---

## Task 7: Update Audit Log Schema

**Files:**
- Modify: `apps/web/src/schemas/audit.ts`

**Step 1: Add activity entity types**

Find the `AuditEntityType` type/enum and add `"activity_type"` and `"activity_entry"` to the allowed values.

**Step 2: Verify compiles**

Run: `pnpm run check`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/web/src/schemas/audit.ts
git commit -m "feat(activity): add activity types to audit entity types"
```

---

## Task 8: Create Activity Type Router

**Files:**
- Create: `apps/web/src/server/api/routers/activity-type.ts`

**Step 1: Create the router file**

```typescript
import { z } from "zod";
import {
  activityTypeId,
  productId,
  unsafeActivityTypeId,
} from "~/schemas/identifiers";
import {
  autocompleteActivityTypes,
  createActivityType,
  deleteActivityType,
  findActivityTypeByProductAndName,
  listActivityTypesByProduct,
  listDueActivityTypes,
  updateActivityType,
} from "~/server/repo/activity-type";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Output schema for activity type with due status
const activityTypeWithStatusOut = z.object({
  id: z.string(),
  productId: z.string(),
  name: z.string(),
  intervalDays: z.number().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastCompletedAt: z.date().nullable(),
  nextDueAt: z.date().nullable(),
  isOverdue: z.boolean(),
  isDueSoon: z.boolean(),
  product: z.object({
    id: z.string(),
    name: z.string(),
    shortcode: z.string(),
  }),
});

// List activity types for a product
const listByProduct = protectedProcedure
  .input(z.object({ productId }))
  .output(z.array(activityTypeWithStatusOut))
  .query(async ({ ctx, input }) => {
    return listActivityTypesByProduct(ctx.db, input.productId);
  });

// List all due/overdue activity types
const listDue = protectedProcedure
  .input(
    z
      .object({
        overdueOnly: z.boolean().optional(),
        dueSoonDays: z.number().optional(),
      })
      .optional(),
  )
  .output(z.array(activityTypeWithStatusOut))
  .query(async ({ ctx, input }) => {
    return listDueActivityTypes(ctx.db, input ?? {});
  });

// Autocomplete activity names for a product
const autocomplete = protectedProcedure
  .input(z.object({ productId, query: z.string() }))
  .output(z.array(z.object({ id: z.string(), name: z.string() })))
  .query(async ({ ctx, input }) => {
    return autocompleteActivityTypes(ctx.db, input.productId, input.query);
  });

// Create activity type
const create = protectedProcedure
  .input(
    z.object({
      productId,
      name: z.string().min(1),
      intervalDays: z.number().positive().nullable().optional(),
    }),
  )
  .output(
    z.object({
      id: z.string(),
      name: z.string(),
      intervalDays: z.number().nullable(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    return createActivityType(
      ctx.db,
      {
        productId: input.productId,
        name: input.name,
        intervalDays: input.intervalDays ?? null,
      },
      ctx.actorContext,
    );
  });

// Find or create activity type (for the "loose enum" pattern)
const findOrCreate = protectedProcedure
  .input(
    z.object({
      productId,
      name: z.string().min(1),
      intervalDays: z.number().positive().nullable().optional(),
    }),
  )
  .output(
    z.object({
      id: z.string(),
      name: z.string(),
      intervalDays: z.number().nullable(),
      created: z.boolean(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    // Check if exists
    const existing = await findActivityTypeByProductAndName(
      ctx.db,
      input.productId,
      input.name,
    );

    if (existing) {
      // Update interval if provided and different
      if (
        input.intervalDays !== undefined &&
        input.intervalDays !== existing.intervalDays
      ) {
        const updated = await updateActivityType(
          ctx.db,
          unsafeActivityTypeId(existing.id),
          { intervalDays: input.intervalDays },
          ctx.actorContext,
        );
        return { ...updated, created: false };
      }
      return { ...existing, created: false };
    }

    // Create new
    const created = await createActivityType(
      ctx.db,
      {
        productId: input.productId,
        name: input.name,
        intervalDays: input.intervalDays ?? null,
      },
      ctx.actorContext,
    );

    return { ...created, created: true };
  });

// Update activity type
const update = protectedProcedure
  .input(
    z.object({
      id: activityTypeId,
      name: z.string().min(1).optional(),
      intervalDays: z.number().positive().nullable().optional(),
    }),
  )
  .output(
    z.object({
      id: z.string(),
      name: z.string(),
      intervalDays: z.number().nullable(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    return updateActivityType(
      ctx.db,
      input.id,
      {
        name: input.name,
        intervalDays: input.intervalDays,
      },
      ctx.actorContext,
    );
  });

// Delete activity type
const remove = protectedProcedure
  .input(z.object({ id: activityTypeId }))
  .mutation(async ({ ctx, input }) => {
    await deleteActivityType(ctx.db, input.id, ctx.actorContext);
    return { success: true };
  });

export const activityTypeRouter = createTRPCRouter({
  listByProduct,
  listDue,
  autocomplete,
  create,
  findOrCreate,
  update,
  delete: remove,
});
```

**Step 2: Verify compiles**

Run: `pnpm run check`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/web/src/server/api/routers/activity-type.ts
git commit -m "feat(activity): add activity type tRPC router"
```

---

## Task 9: Create Activity Entry Router

**Files:**
- Create: `apps/web/src/server/api/routers/activity-entry.ts`

**Step 1: Create the router file**

```typescript
import { z } from "zod";
import { activityEntryId, activityTypeId } from "~/schemas/identifiers";
import { paginationInput } from "~/schemas/pagination";
import {
  createActivityEntry,
  deleteActivityEntry,
  getLatestEntryByType,
  listActivityEntries,
  updateActivityEntry,
} from "~/server/repo/activity-entry";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Output schema for activity entry
const activityEntryOut = z.object({
  id: z.string(),
  activityTypeId: z.string(),
  completedAt: z.date(),
  notes: z.string().nullable(),
  createdAt: z.date(),
  images: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
    }),
  ),
});

// List entries for an activity type
const list = protectedProcedure
  .input(
    z.object({
      activityTypeId,
      pagination: paginationInput.optional(),
    }),
  )
  .output(
    z.object({
      items: z.array(activityEntryOut),
      total: z.number(),
    }),
  )
  .query(async ({ ctx, input }) => {
    const pagination = input.pagination ?? { page: 1, pageSize: 20 };
    return listActivityEntries(ctx.db, input.activityTypeId, pagination);
  });

// Get latest entry for an activity type
const getLatest = protectedProcedure
  .input(z.object({ activityTypeId }))
  .output(activityEntryOut.nullable())
  .query(async ({ ctx, input }) => {
    return getLatestEntryByType(ctx.db, input.activityTypeId);
  });

// Create activity entry
const create = protectedProcedure
  .input(
    z.object({
      activityTypeId,
      completedAt: z.date().optional(), // defaults to now
      notes: z.string().nullable().optional(),
      imageIds: z.array(z.string()).optional(),
    }),
  )
  .output(activityEntryOut)
  .mutation(async ({ ctx, input }) => {
    return createActivityEntry(
      ctx.db,
      {
        activityTypeId: input.activityTypeId,
        completedAt: input.completedAt ?? new Date(),
        notes: input.notes ?? null,
        imageIds: input.imageIds,
      },
      ctx.actorContext,
    );
  });

// Update activity entry
const update = protectedProcedure
  .input(
    z.object({
      id: activityEntryId,
      completedAt: z.date().optional(),
      notes: z.string().nullable().optional(),
    }),
  )
  .output(activityEntryOut)
  .mutation(async ({ ctx, input }) => {
    return updateActivityEntry(
      ctx.db,
      input.id,
      {
        completedAt: input.completedAt,
        notes: input.notes,
      },
      ctx.actorContext,
    );
  });

// Delete activity entry
const remove = protectedProcedure
  .input(z.object({ id: activityEntryId }))
  .mutation(async ({ ctx, input }) => {
    await deleteActivityEntry(ctx.db, input.id, ctx.actorContext);
    return { success: true };
  });

export const activityEntryRouter = createTRPCRouter({
  list,
  getLatest,
  create,
  update,
  delete: remove,
});
```

**Step 2: Verify compiles**

Run: `pnpm run check`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/web/src/server/api/routers/activity-entry.ts
git commit -m "feat(activity): add activity entry tRPC router"
```

---

## Task 10: Register Routers in App Router

**Files:**
- Modify: `apps/web/src/server/api/root.ts`

**Step 1: Import activity routers**

Add imports:

```typescript
import { activityEntryRouter } from "./routers/activity-entry";
import { activityTypeRouter } from "./routers/activity-type";
```

**Step 2: Add to appRouter**

Add to the router object:

```typescript
activityType: activityTypeRouter,
activityEntry: activityEntryRouter,
```

**Step 3: Verify compiles**

Run: `pnpm run check`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/web/src/server/api/root.ts
git commit -m "feat(activity): register activity routers in app router"
```

---

## Task 11: Add Overdue Activities to Problems

**Files:**
- Modify: `apps/web/src/server/repo/problems.ts`
- Modify: `apps/web/src/server/api/routers/problems.ts`

**Step 1: Add findOverdueActivities function to problems.ts**

```typescript
import { listDueActivityTypes } from "~/server/repo/activity-type";

export interface OverdueActivity {
  id: string;
  name: string;
  productId: string;
  productName: string;
  productShortcode: string;
  daysOverdue: number;
  lastCompletedAt: Date | null;
}

const findOverdueActivities = async (
  db: Database,
): Promise<OverdueActivity[]> => {
  const dueTypes = await listDueActivityTypes(db, { overdueOnly: true });

  return dueTypes.map((t) => {
    const daysOverdue = t.nextDueAt
      ? Math.floor(
          (new Date().getTime() - t.nextDueAt.getTime()) / (1000 * 60 * 60 * 24),
        )
      : 0;

    return {
      id: t.id,
      name: t.name,
      productId: t.product.id,
      productName: t.product.name,
      productShortcode: t.product.shortcode,
      daysOverdue,
      lastCompletedAt: t.lastCompletedAt,
    };
  });
};
```

**Step 2: Add to AllProblems interface and findAllProblems**

Add `overdueActivities: OverdueActivity[]` to the interface and include in the Promise.all and return.

**Step 3: Update problems router output schema**

Add the overdue activities schema to the router output.

**Step 4: Verify compiles**

Run: `pnpm run check`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/web/src/server/repo/problems.ts apps/web/src/server/api/routers/problems.ts
git commit -m "feat(activity): add overdue activities to problems dashboard"
```

---

## Task 12: Create Activities Dashboard Route

**Files:**
- Create: `apps/web/src/routes/activities.tsx`

**Step 1: Create the route file**

```typescript
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, Calendar, CheckCircle, Clock } from "lucide-react";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { ListPagePending } from "~/components/route-pending";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/trpc/react";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/activities")({
  ssr: false,
  pendingComponent: ListPagePending,
  errorComponent: RouteErrorComponent,
  component: ActivitiesDashboard,
});

function ActivitiesDashboard() {
  useDocumentTitle("Activities");
  const api = useTRPC();

  const { data: dueActivities, isLoading } = useQuery(
    api.activityType.listDue.queryOptions({ dueSoonDays: 30 }),
  );

  if (isLoading || !dueActivities) {
    return <ListPagePending />;
  }

  const overdue = dueActivities.filter((a) => a.isOverdue);
  const dueSoon = dueActivities.filter((a) => a.isDueSoon && !a.isOverdue);

  return (
    <PageWrapper>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Activities</h1>
          <p className="text-muted-foreground">
            Track maintenance and recurring tasks for your products
          </p>
        </div>

        {/* Overdue Section */}
        {overdue.length > 0 && (
          <Card className="border-destructive">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                Overdue ({overdue.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {overdue.map((activity) => (
                  <Link
                    key={activity.id}
                    to="/products/$id"
                    params={{ id: activity.productId }}
                    className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/50"
                  >
                    <div>
                      <div className="font-medium">{activity.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {activity.product.name}
                      </div>
                    </div>
                    <Badge variant="destructive">
                      {activity.nextDueAt &&
                        formatDistanceToNow(activity.nextDueAt, {
                          addSuffix: true,
                        })}
                    </Badge>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Due Soon Section */}
        {dueSoon.length > 0 && (
          <Card className="border-warning">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-warning">
                <Clock className="h-5 w-5" />
                Due Soon ({dueSoon.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {dueSoon.map((activity) => (
                  <Link
                    key={activity.id}
                    to="/products/$id"
                    params={{ id: activity.productId }}
                    className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/50"
                  >
                    <div>
                      <div className="font-medium">{activity.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {activity.product.name}
                      </div>
                    </div>
                    <Badge variant="outline">
                      {activity.nextDueAt &&
                        formatDistanceToNow(activity.nextDueAt, {
                          addSuffix: true,
                        })}
                    </Badge>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* No Activities */}
        {overdue.length === 0 && dueSoon.length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <CheckCircle className="h-12 w-12 text-muted-foreground" />
              <p className="mt-4 text-lg font-medium">All caught up!</p>
              <p className="text-muted-foreground">
                No activities due in the next 30 days
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </PageWrapper>
  );
}
```

**Step 2: Verify compiles**

Run: `pnpm run check`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/web/src/routes/activities.tsx
git commit -m "feat(activity): add activities dashboard route"
```

---

## Task 13: Add Activities Tab to Product Detail

**Files:**
- Modify: `apps/web/src/app/_components/products/product-detail.tsx`
- Create: `apps/web/src/app/_components/products/product-activities-tab.tsx`

**Step 1: Create ProductActivitiesTab component**

Create `product-activities-tab.tsx`:

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Calendar, Clock, Plus } from "lucide-react";
import { type FC, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { queryKeys } from "~/lib/query-keys";
import type { ProductId } from "~/schemas/identifiers";
import { useTRPC } from "~/trpc/react";

interface ProductActivitiesTabProps {
  productId: ProductId;
}

export const ProductActivitiesTab: FC<ProductActivitiesTabProps> = ({
  productId,
}) => {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [activityName, setActivityName] = useState("");
  const [notes, setNotes] = useState("");
  const [intervalDays, setIntervalDays] = useState<string>("");

  const { data: activityTypes, isLoading } = useQuery(
    api.activityType.listByProduct.queryOptions({ productId }),
  );

  const findOrCreateMutation = useMutation(
    api.activityType.findOrCreate.mutationOptions(),
  );

  const createEntryMutation = useMutation(
    api.activityEntry.create.mutationOptions(),
  );

  const handleLogActivity = async () => {
    if (!activityName.trim()) return;

    // Find or create activity type
    const activityType = await findOrCreateMutation.mutateAsync({
      productId,
      name: activityName.trim(),
      intervalDays: intervalDays ? parseInt(intervalDays, 10) : null,
    });

    // Create entry
    await createEntryMutation.mutateAsync({
      activityTypeId: activityType.id as any,
      notes: notes.trim() || null,
    });

    // Invalidate queries
    await queryClient.invalidateQueries({
      queryKey: queryKeys.activityType.byProduct,
    });

    // Reset form
    setActivityName("");
    setNotes("");
    setIntervalDays("");
    setIsDialogOpen(false);
  };

  if (isLoading) {
    return <div className="p-4">Loading activities...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">Activities</h3>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="mr-2 h-4 w-4" />
              Log Activity
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Log Activity</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="activityName">Activity Name</Label>
                <Input
                  id="activityName"
                  value={activityName}
                  onChange={(e) => setActivityName(e.target.value)}
                  placeholder="e.g., Oil Change, Descale"
                />
              </div>
              <div>
                <Label htmlFor="notes">Notes (optional)</Label>
                <Textarea
                  id="notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Any notes about this activity"
                />
              </div>
              <div>
                <Label htmlFor="intervalDays">
                  Repeat every (days, optional)
                </Label>
                <Input
                  id="intervalDays"
                  type="number"
                  value={intervalDays}
                  onChange={(e) => setIntervalDays(e.target.value)}
                  placeholder="e.g., 90"
                />
              </div>
              <Button
                onClick={handleLogActivity}
                disabled={
                  !activityName.trim() ||
                  findOrCreateMutation.isPending ||
                  createEntryMutation.isPending
                }
              >
                {findOrCreateMutation.isPending || createEntryMutation.isPending
                  ? "Saving..."
                  : "Log Activity"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {activityTypes && activityTypes.length > 0 ? (
        <div className="space-y-2">
          {activityTypes.map((activity) => (
            <div
              key={activity.id}
              className="flex items-center justify-between rounded-lg border p-3"
            >
              <div>
                <div className="font-medium">{activity.name}</div>
                <div className="text-sm text-muted-foreground">
                  {activity.lastCompletedAt ? (
                    <>
                      Last:{" "}
                      {formatDistanceToNow(activity.lastCompletedAt, {
                        addSuffix: true,
                      })}
                    </>
                  ) : (
                    "Never completed"
                  )}
                  {activity.intervalDays && (
                    <span className="ml-2">
                      <Clock className="inline h-3 w-3" /> Every{" "}
                      {activity.intervalDays} days
                    </span>
                  )}
                </div>
              </div>
              {activity.isOverdue && (
                <Badge variant="destructive">Overdue</Badge>
              )}
              {activity.isDueSoon && !activity.isOverdue && (
                <Badge variant="outline">Due soon</Badge>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="py-8 text-center text-muted-foreground">
          No activities logged yet. Click "Log Activity" to add one.
        </div>
      )}
    </div>
  );
};
```

**Step 2: Add tab to product detail**

In `product-detail.tsx`, import and add the activities tab to the sections array.

**Step 3: Verify compiles**

Run: `pnpm run check`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/web/src/app/_components/products/product-activities-tab.tsx apps/web/src/app/_components/products/product-detail.tsx
git commit -m "feat(activity): add activities tab to product detail page"
```

---

## Task 14: Add Navigation Link

**Files:**
- Modify: `apps/web/src/components/layout/sidebar.tsx` (or wherever nav is defined)

**Step 1: Add Activities link to navigation**

Find the navigation items array and add:

```typescript
{
  href: "/activities",
  label: "Activities",
  icon: Calendar, // from lucide-react
}
```

**Step 2: Verify compiles**

Run: `pnpm run check`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/web/src/components/layout/sidebar.tsx
git commit -m "feat(activity): add activities link to navigation"
```

---

## Task 15: Google Sheets Sync - Column Schema

**Files:**
- Modify: `apps/web/src/server/api/routers/google-sheets.ts`

**Step 1: Add activity column schema**

Add after `LOCATION_COLUMN_SCHEMA`:

```typescript
const ACTIVITY_COLUMN_SCHEMA: ColumnSchema[] = [
  { header: "product_shortcode", type: { kind: "text" } },
  { header: "product_name", type: { kind: "text" } },
  { header: "activity", type: { kind: "text" } },
  { header: "completed_at", type: { kind: "datetime" } },
  { header: "notes", type: { kind: "text" } },
  { header: "interval_days", type: { kind: "number" } },
];

const ACTIVITY_CSV_HEADERS = ACTIVITY_COLUMN_SCHEMA.map((col) => col.header);
```

**Step 2: Commit**

```bash
git add apps/web/src/server/api/routers/google-sheets.ts
git commit -m "feat(activity): add activity column schema for Google Sheets"
```

---

## Task 16: Google Sheets Sync - Export Function

**Files:**
- Create: `apps/web/src/server/repo/activity/sheets-export.ts`

**Step 1: Create export function**

```typescript
import { eq, isNull } from "drizzle-orm";
import type { Database } from "~/server/db";
import { activityEntry, activityType, product } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

export interface ActivityCSVRow {
  product_shortcode: string;
  product_name: string;
  activity: string;
  completed_at: string;
  notes: string;
  interval_days: string;
}

export const exportActivitiesToCSV = async (
  db: Database,
): Promise<ActivityCSVRow[]> => {
  const entries = await getDb(db).query.activityEntry.findMany({
    with: {
      activityType: {
        with: {
          product: {
            columns: { shortcode: true, name: true },
          },
        },
      },
    },
    orderBy: (e, { asc, desc }) => [
      asc(activityType.productId),
      asc(activityType.name),
      desc(e.completedAt),
    ],
  });

  // Track which activity types we've output interval for
  const intervalOutput = new Set<string>();

  return entries.map((entry) => {
    const isFirstForType = !intervalOutput.has(entry.activityTypeId);
    if (isFirstForType) {
      intervalOutput.add(entry.activityTypeId);
    }

    return {
      product_shortcode: entry.activityType.product.shortcode,
      product_name: entry.activityType.product.name,
      activity: entry.activityType.name,
      completed_at: entry.completedAt.toISOString(),
      notes: entry.notes ?? "",
      // Only output interval on first row for each activity type
      interval_days:
        isFirstForType && entry.activityType.intervalDays
          ? String(entry.activityType.intervalDays)
          : "",
    };
  });
};
```

**Step 2: Commit**

```bash
git add apps/web/src/server/repo/activity/sheets-export.ts
git commit -m "feat(activity): add activity sheets export function"
```

---

## Task 17: Google Sheets Sync - Import Function

**Files:**
- Create: `apps/web/src/server/repo/activity/sheets-import.ts`

**Step 1: Create import function**

```typescript
import { eq } from "drizzle-orm";
import type { ActorContext } from "~/schemas/context";
import {
  unsafeActivityEntryId,
  unsafeActivityTypeId,
  unsafeProductId,
} from "~/schemas/identifiers";
import type { Database } from "~/server/db";
import { activityEntry, activityType, product } from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  getDb,
  insertAndReturnDb,
  withTransaction,
} from "~/server/repo/database-helpers";

export interface ActivityCSVRow {
  product_shortcode: string;
  product_name: string;
  activity: string;
  completed_at: string;
  notes: string;
  interval_days: string;
}

export interface ImportResult {
  typesCreated: number;
  typesUpdated: number;
  entriesCreated: number;
  entriesSkipped: number;
  errors: string[];
}

export const importActivitiesFromCSV = async (
  db: Database,
  rows: ActivityCSVRow[],
  actorContext: ActorContext,
): Promise<ImportResult> => {
  const result: ImportResult = {
    typesCreated: 0,
    typesUpdated: 0,
    entriesCreated: 0,
    entriesSkipped: 0,
    errors: [],
  };

  return withTransaction(db, async (tx) => {
    // Cache product lookups
    const productCache = new Map<string, string>(); // shortcode -> id
    // Cache activity type lookups
    const typeCache = new Map<string, { id: string; intervalDays: number | null }>();

    for (const row of rows) {
      try {
        // Find product by shortcode
        let productId = productCache.get(row.product_shortcode);
        if (!productId) {
          const prod = await tx.query.product.findFirst({
            where: eq(product.shortcode, row.product_shortcode),
            columns: { id: true },
          });
          if (!prod) {
            result.errors.push(
              `Product not found: ${row.product_shortcode}`,
            );
            continue;
          }
          productId = prod.id;
          productCache.set(row.product_shortcode, productId);
        }

        // Find or create activity type
        const typeKey = `${productId}:${row.activity}`;
        let type = typeCache.get(typeKey);

        if (!type) {
          const existing = await tx.query.activityType.findFirst({
            where: (t, { and, eq }) =>
              and(eq(t.productId, productId!), eq(t.name, row.activity)),
            columns: { id: true, intervalDays: true },
          });

          if (existing) {
            type = { id: existing.id, intervalDays: existing.intervalDays };
          } else {
            // Create new type
            const intervalDays = row.interval_days
              ? parseInt(row.interval_days, 10)
              : null;

            const created = await insertAndReturnDb(db, activityType, {
              productId: productId!,
              name: row.activity,
              intervalDays,
            });

            await logAuditEntry(
              db,
              "activity_type",
              unsafeActivityTypeId(created.id),
              "create",
              null,
              actorContext,
              "sheets_import",
            );

            type = { id: created.id, intervalDays };
            result.typesCreated++;
          }

          typeCache.set(typeKey, type);
        }

        // Update interval if provided and different
        if (
          row.interval_days &&
          type.intervalDays !== parseInt(row.interval_days, 10)
        ) {
          const newInterval = parseInt(row.interval_days, 10);
          await tx
            .update(activityType)
            .set({ intervalDays: newInterval })
            .where(eq(activityType.id, type.id));

          type.intervalDays = newInterval;
          result.typesUpdated++;
        }

        // Parse completed_at
        const completedAt = new Date(row.completed_at);
        if (isNaN(completedAt.getTime())) {
          result.errors.push(
            `Invalid date for ${row.product_shortcode}/${row.activity}: ${row.completed_at}`,
          );
          continue;
        }

        // Check for existing entry with same timestamp
        const existingEntry = await tx.query.activityEntry.findFirst({
          where: (e, { and, eq }) =>
            and(eq(e.activityTypeId, type!.id), eq(e.completedAt, completedAt)),
          columns: { id: true },
        });

        if (existingEntry) {
          // Update notes if different
          result.entriesSkipped++;
          continue;
        }

        // Create entry
        const entry = await insertAndReturnDb(db, activityEntry, {
          activityTypeId: type.id,
          completedAt,
          notes: row.notes || null,
        });

        await logAuditEntry(
          db,
          "activity_entry",
          unsafeActivityEntryId(entry.id),
          "create",
          null,
          actorContext,
          "sheets_import",
        );

        result.entriesCreated++;
      } catch (err) {
        result.errors.push(
          `Error processing row ${row.product_shortcode}/${row.activity}: ${err}`,
        );
      }
    }

    return result;
  });
};
```

**Step 2: Commit**

```bash
git add apps/web/src/server/repo/activity/sheets-import.ts
git commit -m "feat(activity): add activity sheets import function"
```

---

## Task 18: Add Activity Sync to Google Sheets Router

**Files:**
- Modify: `apps/web/src/server/api/routers/google-sheets.ts`

**Step 1: Add activity sheet name constant**

Add to `SHEET_NAMES` (or create if needed):

```typescript
const SHEET_NAMES = {
  INVENTORY: "Inventory",
  LOCATIONS: "Locations",
  ACTIVITIES: "Activities",
};
```

**Step 2: Add syncActivities procedure**

Add export and import procedures for activities similar to inventory sync pattern.

**Step 3: Verify compiles**

Run: `pnpm run check`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/web/src/server/api/routers/google-sheets.ts
git commit -m "feat(activity): add activity sync to Google Sheets router"
```

---

## Task 19: Final Verification

**Step 1: Run full type check**

Run: `pnpm run check`
Expected: PASS with no errors

**Step 2: Format code**

Run: `pnpm run format:write`

**Step 3: Run dev server and test**

Run: `pnpm dev`

Test:
1. Navigate to `/activities` - should show empty state
2. Navigate to a product, click "Log Activity"
3. Enter activity name, optional notes, optional interval
4. Verify activity appears in product activities tab
5. Navigate back to `/activities` - should show due activities
6. Check `/problems` - should show overdue activities if any

**Step 4: Commit any format fixes**

```bash
git add -A
git commit -m "chore: format code"
```

---

## Summary

| Task | Description |
|------|-------------|
| 1 | Add branded ID types for ActivityTypeId and ActivityEntryId |
| 2 | Add database schema (activity_type, activity_entry, activity_entry_image) |
| 3 | Generate and run migration |
| 4 | Add query keys |
| 5 | Create activity type repository |
| 6 | Create activity entry repository |
| 7 | Update audit log schema |
| 8 | Create activity type tRPC router |
| 9 | Create activity entry tRPC router |
| 10 | Register routers in app router |
| 11 | Add overdue activities to problems dashboard |
| 12 | Create activities dashboard route |
| 13 | Add activities tab to product detail |
| 14 | Add navigation link |
| 15 | Add Google Sheets column schema |
| 16 | Create sheets export function |
| 17 | Create sheets import function |
| 18 | Add activity sync to Google Sheets router |
| 19 | Final verification |
