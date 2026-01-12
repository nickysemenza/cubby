---
status: pending
priority: p1
issue_id: "001"
tags: [google-sheets, sync, race-condition, data-integrity, critical]
dependencies: []
---

# Race Condition: Preview vs. Apply Sync Time Gap

## Problem Statement

The Google Sheets sync operates in two separate transactions with a dangerous time gap:
1. User calls `syncPreview` → reads DB and Sheets, shows conflicts
2. User makes decisions, calls `applySync` → reads DB and Sheets AGAIN, then applies changes

Between these two steps, the database OR Google Sheets could change, leading to:
- Data loss from applying stale resolutions to new data
- Orphaned records (location deleted between preview/apply, leaving inventory behind)
- Duplicate entries (item added between preview/apply gets imported twice)
- Lost updates (concurrent changes overwritten silently)

**Location**: `apps/web/src/server/api/routers/google-sheets.ts:1363-1598`

**Severity**: CRITICAL - High probability of data corruption in production with multiple users or external sheet updates.

## Findings

**Evidence from code review:**

Line 1370 (`syncPreview`):
```typescript
const { locationItems, inventoryItems } = await fetchAndCompareData(ctx, client, sheetId);
```

Line 1448 (`applySync`):
```typescript
const { locationItems, inventoryItems, sheetLocations, sheetInventory } =
  await fetchAndCompareData(ctx, client, sheetId);
// Data fetched AGAIN - no locking, no version checking
```

**Attack scenarios identified:**
1. User A previews sync, sees matched item
2. User B deletes item from app
3. User A applies sync → tries to update deleted item → error/corruption
4. Sheet could be edited externally between preview and apply
5. Concurrent syncs from different users corrupt data

**No protection mechanisms found:**
- No ETags or version stamps
- No optimistic locking
- No change detection between preview/apply
- No transaction spanning both operations

## Proposed Solutions

### Solution 1: Snapshot-Based Sync with Version Checking

**Approach**: Include a snapshot timestamp/hash in `syncPreview` response, validate in `applySync`.

```typescript
// In syncPreview:
const snapshotHash = crypto.createHash('sha256')
  .update(JSON.stringify({ locationItems, inventoryItems }))
  .digest('hex');

return {
  ...previewResult,
  snapshotHash,
  snapshotTimestamp: Date.now()
};

// In applySync:
const currentSnapshot = await fetchAndCompareData(...);
const currentHash = crypto.createHash('sha256')
  .update(JSON.stringify({ ...currentSnapshot }))
  .digest('hex');

if (input.snapshotHash !== currentHash) {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: "Data changed since preview. Please refresh and try again."
  });
}
```

**Pros:**
- Detects any changes between preview/apply
- Simple to implement
- No infrastructure changes needed

**Cons:**
- Requires UI changes to pass snapshot hash
- User must re-preview if data changed (could be frequent)
- Hash computation adds overhead

**Effort**: Medium (2-3 days)
**Risk**: Low (backward compatible, clear error messages)

---

### Solution 2: Optimistic Locking with updatedAt Timestamps

**Approach**: Check that no entities changed between preview and apply using timestamps.

```typescript
// In preview, capture all entity timestamps:
const entityVersions = {
  products: appInventory.map(i => ({ id: i.product_id, updatedAt: i.product_updated_at })),
  locations: appLocations.map(l => ({ id: l.location_id, updatedAt: l.location_updated_at })),
  inventory: appInventory.map(i => ({ id: i.inventory_entry_id, updatedAt: i.inventory_updated_at }))
};

// In apply, verify versions match:
for (const { id, updatedAt } of input.entityVersions.products) {
  const current = await getProduct(db, id);
  if (current.updatedAt > updatedAt) {
    throw new TRPCError({ code: "CONFLICT", message: "Product was modified" });
  }
}
```

**Pros:**
- Standard database pattern
- Fine-grained conflict detection
- Can show user exactly what changed

**Cons:**
- Requires querying all entities again in apply
- More complex implementation
- Needs SYNC_TIMESTAMPS feature flag enabled

**Effort**: High (4-5 days)
**Risk**: Medium (schema changes, more queries)

---

### Solution 3: Application-Level Locking

**Approach**: Use Redis/database lock to prevent concurrent syncs on same sheet.

```typescript
async function applySync({ ctx, input }) {
  const lockKey = `sync:${ctx.userId}:${sheetId}`;
  const lock = await acquireLock(lockKey, { ttl: 60000 });

  try {
    // Perform sync...
  } finally {
    await lock.release();
  }
}
```

**Pros:**
- Prevents concurrent syncs completely
- Simple to reason about
- Works with existing code

**Cons:**
- Requires Redis or similar infrastructure
- Lock contention if users spam sync
- Doesn't detect external sheet changes
- Single point of failure (lock service)

**Effort**: Medium (3-4 days including infrastructure)
**Risk**: Medium (new dependency, failure modes)

## Recommended Action

**Phase 1 (Immediate - 2 days)**: Implement Solution 1 (Snapshot-Based Sync)
- Add `snapshotHash` to preview response
- Validate hash in apply, force re-preview on mismatch
- Add UI toast: "Data changed, please review again"

**Phase 2 (Short-term - 1 week)**: Add Solution 3 (Locking) on top
- Prevent concurrent syncs as defense-in-depth
- Start with in-memory lock (Node cluster aware)
- Upgrade to Redis if needed for multi-instance

**Phase 3 (Long-term - 2 weeks)**: Consider Solution 2 for fine-grained conflicts
- Show users exactly what changed (diff view)
- Allow merging non-conflicting changes
- Requires UX design work

## Technical Details

**Affected Files:**
- `apps/web/src/server/api/routers/google-sheets.ts` (lines 1363-1598)
- `apps/web/src/schemas/sync.ts` (add snapshot fields)
- Frontend sync components (pass snapshot hash)

**Database Changes:** None for Phase 1

**API Changes:**
- `syncPreview` output: add `snapshotHash: string` field
- `applySync` input: add `snapshotHash: string` field

## Acceptance Criteria

- [ ] `syncPreview` returns a unique snapshot identifier
- [ ] `applySync` validates snapshot hasn't changed since preview
- [ ] If data changed, user gets clear error with actionable message
- [ ] Integration test: Concurrent syncs don't corrupt data
- [ ] Integration test: External sheet edits between preview/apply are detected
- [ ] Load test: 10 users syncing simultaneously without data loss
- [ ] UI shows appropriate error when snapshot is stale

## Work Log

### 2026-01-12 - Initial Analysis

**By:** Claude Code Review Agent

**Actions:**
- Comprehensive code review of Google Sheets sync system
- Identified race condition between preview and apply phases
- Analyzed potential data corruption scenarios
- Designed three solution approaches with tradeoffs

**Findings:**
- No version checking exists between operations
- fetchAndCompareData called separately in both procedures
- Time gap allows data to change without detection
- Affects both database and Google Sheets changes

**Learnings:**
- Two-phase operations without locking are inherently race-prone
- Snapshot-based validation is simplest immediate fix
- Long-term needs optimistic concurrency control

## Resources

- Code location: `apps/web/src/server/api/routers/google-sheets.ts:1363-1598`
- Related: Transaction safety issue (see issue #002)
- Pattern: https://martinfowler.com/eaaCatalog/optimisticOfflineLock.html

## Notes

This is a **CRITICAL** issue that blocks production deployment with multiple users. The risk of data loss is high in any concurrent usage scenario. Recommend implementing Solution 1 (snapshot validation) immediately as it provides significant protection with minimal code changes.

The root cause is architectural - treating sync as two independent operations when they should be logically atomic. Full fix requires rethinking the preview/apply pattern, possibly moving to an "edit draft, then commit" model.
