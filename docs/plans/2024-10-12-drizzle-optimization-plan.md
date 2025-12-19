# Drizzle Optimization Plan

## Overview

Remaining optimizations to reduce verbosity in our Drizzle implementation while maintaining type safety and the opaque Database pattern.

**Completed:**
- Phase 3: Relation Loaders (`relations` object in database-helpers.ts)
- Phase 5: Transaction Helpers (`insertAndReturn`, `batchInsert`, `updateAndReturn`)

## Phase 1: Query Builder Helpers (NOT DONE)

### Current Problem
```typescript
// Repeated pattern across all list functions
const whereCondition = and(
  eq(table.projectId, projectId),
  nameFilter ? ilike(table.name, `%${nameFilter}%`) : undefined,
).filter(Boolean);

const orderByArray =
  direction === "desc" ? [desc(table[orderBy])] : [asc(table[orderBy])];

const results = await getDb(db)
  .query.table.findMany({
    where: whereCondition,
    orderBy: orderByArray,
    limit: take,
    offset: skip,
  });
```

### Solution: Generic Query Builder
```typescript
// database-helpers.ts
export const buildListQuery = <T extends { projectId: string; name: string }>(
  table: T,
  projectId: string,
  filters?: {
    name?: string;
    custom?: SQL[];
  },
  sort?: { orderBy: keyof T; direction: "asc" | "desc" },
  pagination?: { take: number; skip: number },
) => {
  const conditions = [
    eq(table.projectId, projectId),
    filters?.name ? ilike(table.name, `%${filters.name}%`) : undefined,
    ...(filters?.custom ?? []),
  ].filter(Boolean);

  const orderByArray = sort
    ? sort.direction === "desc"
      ? [desc(table[sort.orderBy])]
      : [asc(table[sort.orderBy])]
    : [];

  return {
    where: and(...conditions),
    orderBy: orderByArray,
    limit: pagination?.take,
    offset: pagination?.skip,
  };
};
```

**Impact**: Reduces list functions from ~40 lines to ~15 lines each

## Phase 2: CRUD Shortcuts (NOT DONE)

### Current Problem
```typescript
export const createIngredient = async (
  ingredientIn: IngredientCreateInput,
  db: Database,
  projectId: ProjectId,
): Promise<typeof ingredient.$inferSelect> => {
  const [created] = await getDb(db)
    .insert(ingredient)
    .values({
      projectId: projectId,
      name: ingredientIn.name,
      aliases: ingredientIn.aliases,
    })
    .returning();
  return created!;
};
```

### Solution: Generic CRUD Helpers
```typescript
// database-helpers.ts
export const createEntity = async <
  TTable extends { $inferInsert: any; $inferSelect: any },
>(
  db: Database,
  table: TTable,
  values: TTable["$inferInsert"],
): Promise<TTable["$inferSelect"]> => {
  const [created] = await getDb(db).insert(table).values(values).returning();
  return created!;
};

export const updateEntity = async <
  TTable extends { $inferInsert: any; $inferSelect: any },
>(
  db: Database,
  table: TTable,
  id: string,
  values: Partial<TTable["$inferInsert"]>,
): Promise<TTable["$inferSelect"]> => {
  const [updated] = await getDb(db)
    .update(table)
    .set(values)
    .where(eq(table.id, id))
    .returning();
  return updated!;
};

export const deleteEntity = async <TTable extends { id: any }>(
  db: Database,
  table: TTable,
  id: string,
): Promise<void> => {
  await getDb(db).delete(table).where(eq(table.id, id));
};
```

**Impact**: Reduces simple create/update functions from ~11 lines to ~7 lines each

## Phase 4: Pagination Builder (NOT DONE)

### Current Problem
```typescript
const [results, [countResult]] = await Promise.all([
  getDb(db).query.ingredient.findMany({
    where: whereCondition,
    orderBy: orderByArray,
    limit: take,
    offset: skip,
  }),
  getDb(db)
    .select({ count: sql<number>`count(*)` })
    .from(ingredient)
    .where(whereCondition),
]);

return buildPaginatedResponse(
  results,
  Number(countResult?.count ?? 0),
  pageIndex,
  pageSize,
);
```

### Solution: Unified Pagination Helper
```typescript
// database-helpers.ts
export const buildPaginatedQuery = async <T>(
  db: Database,
  tableName: string,
  query: {
    where?: SQL;
    orderBy?: SQL[];
    limit?: number;
    offset?: number;
    with?: any;
  },
  pageIndex: number,
  pageSize: number,
): Promise<{ data: T[]; count: number; pageIndex: number; pageSize: number }> => {
  const table = schema[tableName];

  const [results, [countResult]] = await Promise.all([
    getDb(db).query[tableName].findMany(query) as Promise<T[]>,
    getDb(db)
      .select({ count: sql<number>`count(*)` })
      .from(table)
      .where(query.where),
  ]);

  return buildPaginatedResponse(
    results,
    Number(countResult?.count ?? 0),
    pageIndex,
    pageSize,
  );
};
```

**Impact**: Reduces pagination code from ~18 lines to ~7 lines

## Implementation Order

1. **Phase 1** (Query Builder Helpers) - Foundation for all list operations
2. **Phase 4** (Pagination Builder) - Depends on Phase 1
3. **Phase 2** (CRUD Shortcuts) - Independent, can be done anytime
