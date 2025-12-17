# ActorContext Design

## Summary

Introduce `ActorContext` to consolidate `userId`, `organizationId`, and `source` into a single object passed through repo functions. This provides consistency across the codebase and simplifies audit logging.

## Motivation

- Functions inconsistently receive `organizationId` and `userId` as separate parameters
- Audit source needs to be threaded through import flows separately
- Want a standard "actor context" pattern for who is performing actions

## Design

### ActorContext Type

**New file:** `apps/web/src/schemas/context.ts`

```typescript
import { type UserId, type OrganizationId } from "./identifiers";
import { type AuditSource } from "~/server/repo/audit-log";

export interface ActorContext {
  userId: UserId;
  organizationId: OrganizationId;
  source: AuditSource;
}

export function buildActorContext(
  userId: UserId,
  organizationId: OrganizationId,
  source: AuditSource = "ui",
): ActorContext {
  return { userId, organizationId, source };
}
```

All fields are required. If a function doesn't need all three, it shouldn't take `ActorContext`.

### tRPC Integration

In `createTRPCContext`, add `actorContext` to the returned context:

```typescript
actorContext: organizationId && betterSession?.user?.id
  ? buildActorContext(
      unsafeUserId(betterSession.user.id),
      organizationId,
      "ui",
    )
  : null,
```

Add helper in trpc.ts:

```typescript
export function requireActorContext(ctx: { actorContext: ActorContext | null }): ActorContext {
  if (!ctx.actorContext) {
    throw createAppError("UNAUTHORIZED", "Authentication required");
  }
  return ctx.actorContext;
}
```

### Repo Function Signatures

**Before:**
```typescript
export const createProduct = async (
  db: Database,
  data: ProductInputPayload,
  organizationId: OrganizationId,
  userId: UserId,
): Promise<ProductTopLevelOut>
```

**After:**
```typescript
export const createProduct = async (
  db: Database,
  data: ProductInputPayload,
  actor: ActorContext,
): Promise<ProductTopLevelOut> => {
  const { organizationId, userId } = actor;
  // ...
}
```

Note: `db` stays separate from `ActorContext` since it's infrastructure (can be transaction vs connection).

### Audit Logging

Audit log calls become cleaner with spread:

```typescript
await logAuditEntry(db, {
  ...actor,  // spreads userId, organizationId, source
  entityType: "product",
  entityId: newProduct.id,
  action: "create",
});
```

### Router Usage

```typescript
// Standard usage
const actor = requireActorContext(ctx);
await createProduct(db, data, actor);

// Override source for imports
const actor = { ...requireActorContext(ctx), source: "csv_import" as const };
await importInventoryFromCSV(db, orgId, rows, { actor });
```

## Files to Modify

### New Files
- `apps/web/src/schemas/context.ts`

### Core Infrastructure
- `apps/web/src/server/api/trpc.ts` - add actorContext, requireActorContext
- `apps/web/src/server/repo/audit-log.ts` - update AuditLogInput

### Repo Layer
- `apps/web/src/server/repo/product.ts`
- `apps/web/src/server/repo/ingredient.ts`
- `apps/web/src/server/repo/recipe.ts`
- `apps/web/src/server/repo/location.ts`
- `apps/web/src/server/repo/compactrecipe.ts`
- `apps/web/src/server/repo/inventory/crud.ts`
- `apps/web/src/server/repo/inventory/bulk.ts`
- `apps/web/src/server/repo/inventory/csv-import/*.ts`

### Router Layer
- All routers that call the above repos

### Test Files
- Create `TEST_ACTOR` constant replacing separate user/org IDs

## Decisions

- **All fields required** - Partial context not allowed
- **db stays separate** - Different concern than actor identity
- **Default source is "ui"** - Override at call site for imports
- **Migration: all at once** - Single refactor rather than incremental
