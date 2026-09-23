# Repository Layer Documentation

This directory contains the repository (repo) layer, which provides the **only** interface for database access in the application. All database operations must go through this layer.

## Architecture Overview

The repository layer follows a strict access control pattern using TypeScript's type system to enforce database access boundaries:

```
┌─────────────┐
│   Workflow  │  (Start functions / MCP adapters)
└──────┬──────┘
       │ passes Database (request-scoped handle)
       ▼
┌─────────────┐
│  Service    │  (business logic)
└──────┬──────┘
       │ passes Database (request-scoped handle)
       ▼
┌─────────────┐
│    Repo     │  ← ONLY layer that can access database methods
└─────────────┘
```

## Opaque Database Type

### What is it?

`Database` is a **request-scoped handle** without query methods of its own.
Repository helpers resolve its Drizzle client; services and routers keep the
handle at the boundary and do not resolve it directly:

```typescript
// In ~/server/db/database.ts
export class Database {
  /* runtime handle; no query methods */
}
```

This keeps code like this out of routers and services by convention and API
locality:

```typescript
// ❌ This will NOT compile in routers or services:
const users = await db.query.user.findMany(); // Error!

// ✅ This is the correct way:
const users = await userRepo.listUsers(db, ...params);
```

### How to use it

**In Repo Files:**

Use the `getDb()` helper to unwrap the opaque type:

```typescript
import { getDb } from "~/server/repo/database-helpers";

export const getUserById = async (db: Database, id: string) => {
  // Resolve the request-scoped handle only at the repository boundary
  const result = await getDb(db).query.user.findFirst({
    where: eq(user.id, id),
  });
  return result;
};
```

**In Services/Routers:**

Just pass the `Database` around - you can't call methods on it:

```typescript
export const createUser = async (db: Database, data: UserInput) => {
  // Services can only pass Database to repo functions
  return await userRepo.createUser(db, data);
};
```

### Working with Transactions

For transactions, use either `Transaction` type or `Database | Transaction` union:

```typescript
import { withTransaction, unwrapDb } from "~/server/repo/database-helpers";

// Option 1: Explicit transaction
export const complexOperation = async (db: Database) => {
  return await withTransaction(db, async (tx) => {
    // tx is DrizzleTransaction - can call methods directly
    await tx.insert(user).values({ ... });
    await tx.insert(profile).values({ ... });
  });
};

// Option 2: Flexible function accepting both
export const flexibleFunction = async (
  db: Database | DrizzleTransaction,
  data: SomeData
) => {
  // Use unwrapDb() to safely handle both types
  const client = unwrapDb(db);
  return await client.query.something.findFirst({ ... });
};
```

## Database Helper Functions

The `database-helpers.ts` file provides utilities to reduce boilerplate:

### Query Helpers

```typescript
import { buildOrderBy, formatSearchTerm } from "~/server/repo/database-helpers";

// Build ORDER BY clauses with field validation
const orderBy = buildOrderBy(
  user,
  { orderBy: "createdAt", direction: "desc" },
  ["createdAt", "name", "email"], // allowed fields
);

// Safe search term formatting for ILIKE
const whereClause = formatSearchTerm(user.name, searchQuery);
```

### CRUD Helpers

```typescript
import {
  insertAndReturn,
  updateAndReturn,
} from "~/server/repo/database-helpers";

// Insert and return in one call
const newUser = await insertAndReturn(tx, user, {
  name: "Alice",
  email: "alice@example.com",
});

// Update and return in one call
const updated = await updateAndReturn(
  tx,
  user,
  { name: "Alice Updated" },
  eq(user.id, userId),
);
```

### Batch Operations

```typescript
import { batchUpdateWithCaseWhen } from "~/server/repo/database-helpers";

// Update many records in a single SQL CASE WHEN statement (auto-chunked)
const updatedCount = await batchUpdateWithCaseWhen(tx, product, [
  { id: "p1", priceCents: 199 },
  { id: "p2", priceCents: 299 },
]);
```

### Transformation Helpers

DB-to-API transformations often require repetitive patterns. These helpers reduce duplication:

```typescript
import { mapImages, mapRelation } from "~/server/repo/database-helpers";

// Project images from join-table (or bare) rows, dropping soft-deleted
// Before: const images = product.images?.map((pi) => pi.image) ?? [];
// After:
const images = mapImages(product.images);

// Map relations with null safety
// Before: const products = Product?.map((p) => transform(p)) ?? [];
// After:
const products = mapRelation(Product, (p) => transform(p));
```

### Relation Loaders

Pre-configured relation loaders reduce verbosity:

```typescript
import { relations } from "~/server/repo/database-helpers";

// Instead of manually typing all relations:
const product = await getDb(db).query.product.findFirst({
  where: eq(product.id, productId),
  with: {
    unitMappings: true,
    images: { with: { image: true } },
    Ingredient: true,
    InventoryEntry: { with: { location: true } },
  },
});

// Use predefined relations:
const product = await getDb(db).query.product.findFirst({
  where: eq(product.id, productId),
  ...relations.product.full,
});
```

## DB-to-API Transformation Pattern

Repos transform database records to API types to:

1. Apply branded types (e.g., `ProductId`, `LocationId`)
2. Extract nested join table data (e.g., images)
3. Validate shapes with Zod schemas

### Type Assertion Helpers

For complex query results, use type assertion helpers:

```typescript
type IngredientDeepDB = typeof ingredient.$inferSelect & {
  Product: Array<...>;
  Recipe: ...;
};

/**
 * Type assertion helper for ingredient query results.
 * Safe when query includes relations.ingredient.full.
 */
const asIngredientDeepDB = (
  data: typeof ingredient.$inferSelect & Record<string, unknown>
): IngredientDeepDB => {
  return data as IngredientDeepDB;
};

// Usage:
const ing = await getDb(db).query.ingredient.findFirst({
  ...relations.ingredient.full,
});
return dbIngredientToAPI(db, asIngredientDeepDB(ing));
```

### Runtime Validation

For critical transformations, use Zod to validate at runtime:

```typescript
import { productTopLevelOut } from "~/schemas/product";

const result = {
  ...productData,
  images: fetchedImages,
};

// Validate the shape before returning
return productTopLevelOut.parse(result);
```

## Common Patterns

### 1. Branded ID Types

See [IDs and runtime traps](../../../../../docs/agents/domain-rules.md#ids-and-runtime-traps)
for the branding/parsing rules. The repo-specific addendum: a repo mapper
reading a raw DB projection (untyped `id`/foreign-key columns off the driver
row) is itself a genuine ingress seam, so parse there with `parseEntityId` /
the named `<entity>Id` schema before the value reaches API-typed output —
never pass the raw column straight through.

### 2. Extracting Images

Images use join tables, extract them explicitly:

```typescript
// Database structure: product -> productImage -> image
const productImages = product.images?.map((pi) => pi.image) ?? [];

return {
  ...product,
  images: productImages, // Now array of image records
};
```

### 3. Timestamp Extraction

Use the helper for consistent timestamp handling:

```typescript
import { extractDbTimestampsFromDBRec } from "~/schemas/common";

return {
  ...otherFields,
  ...extractDbTimestampsFromDBRec(dbRecord),
};
```

### 4. Search and Pagination

Combine helpers for clean pagination:

```typescript
import { buildTakeSkip } from "~/schemas/pagination";

const whereClause = and(
  eq(product.organizationId, orgId),
  formatSearchTerm(product.name, searchQuery),
);

const orderBy = buildOrderBy(product, sort, ["name", "createdAt"]);
const { take, skip } = buildTakeSkip(pagination);

const [results, [countResult]] = await Promise.all([
  getDb(db).query.product.findMany({
    where: whereClause,
    orderBy,
    limit: take,
    offset: skip,
  }),
  getDb(db).select({ count: count() }).from(product).where(whereClause),
]);
```

## Best Practices

### ✅ DO

- Keep all database access in repo files
- Use helper functions to reduce boilerplate
- Add clear comments for complex queries
- Use transactions for multi-step operations
- Validate API output with Zod schemas
- Extract images from join tables explicitly

### ❌ DON'T

- Call database methods directly in services/routers
- Use raw SQL unless necessary (prefer query builder)
- Use `as unknown as` casts (use Zod or type helpers instead)
- Forget to handle null/undefined in optional fields

## Testing

Repo functions should have integration tests that use a real database:

```typescript
describe("getUserById", () => {
  it("should return user with correct shape", async () => {
    const db = getTestDatabase();
    const user = await userRepo.getUserById(db, testUserId);

    expect(user).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      createdAt: expect.any(Date),
    });
  });
});
```

See existing `.integration.test.ts` files for examples.

## Further Reading

- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [Project AGENTS.md](../../../../../AGENTS.md) - Full architecture guidelines
- [Schema Definitions](../db/schema.ts) - Database schema
- [Agent domain rules](../../../../../docs/agents/domain-rules.md) - Production changes, data/layers/deletion, IDs and runtime traps
- [Entity genericization](../../../../../docs/entities.md) - The manifest/binding spine and new-entity checklist
