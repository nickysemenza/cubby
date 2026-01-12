---
status: pending
priority: p1
issue_id: "002"
tags: [google-sheets, sync, transactions, data-integrity, atomicity]
dependencies: []
---

# No Transaction Wrapping for Sync Operations

## Problem Statement

The `applySync` procedure performs multiple database mutations WITHOUT a transaction wrapper:
1. Process imports (creates/updates locations and inventory)
2. Process deletions (removes locations and inventory)
3. Process renames (updates product/location names)
4. Write to Google Sheets
5. Update last sync timestamp

If ANY of these operations fail midway:
- Database is left in inconsistent state
- Google Sheets might be written with partial data
- No rollback mechanism exists
- Users see success/failure but don't know which items actually synced
- Recovery requires manual intervention

**Location**: `apps/web/src/server/api/routers/google-sheets.ts:1479-1507`

**Severity**: CRITICAL - Guaranteed data corruption on any failure during sync.

## Findings

**Evidence from code:**

```typescript
// Line 1479-1507: No transaction wrapper
const results = createEmptySyncResults();

// Line 1483: Process imports (creates/updates)
await processImportsToApp(...);

// Line 1494: Process deletions
await processAppDeletions(...);

// Line 1502: Process renames
await processRenames(...);

// Line 1509: Push to sheets (if this fails, DB already changed!)
await pushLocationsToSheet(...);
await pushInventoryToSheet(...);
```

**No `withTransaction` wrapper around the entire sync operation.**

Each individual operation might use transactions internally, but the whole sync is not atomic.

**Failure scenarios:**
1. Locations imported successfully → inventory import fails → database has orphaned locations
2. Database mutations succeed → Google Sheets write fails → systems diverge permanently
3. Deletions succeed → renames fail → some items deleted, others not renamed
4. Partial sync leaves database in unknown state → next sync sees phantom conflicts

## Proposed Solutions

### Solution 1: Wrap Entire Sync in Single Transaction (Recommended)

**Approach**: All database mutations in one transaction, sheets written after commit.

```typescript
await withTransaction(ctx.db, async (tx) => {
  const results = createEmptySyncResults();

  // All DB mutations inside transaction
  await processImportsToApp({ db: tx, ... }, locationItems, inventoryItems, results);
  await processAppDeletions({ db: tx, ... }, locationItems, inventoryItems, results);
  await processRenames({ db: tx, ... }, locationItems, inventoryItems, results);

  // Transaction commits here
});

// Only write to sheets if DB changes succeeded
await pushLocationsToSheet(...);
await pushInventoryToSheet(...);
await updateLastSyncTimestamp(...);
```

**Pros:**
- All database changes are atomic
- Rollback on any error
- Clean error handling
- Consistent state guaranteed

**Cons:**
- Long-running transaction risk (timeout)
- If sheets write fails, DB is committed but sheets outdated
- Need to track "DB committed but sheets failed" state

**Effort**: Low (1-2 days)
**Risk**: Medium (transaction timeout risk for large syncs)

---

### Solution 2: Two-Phase Commit Pattern

**Approach**: Prepare changes, commit DB, then commit sheets with compensation logic.

```typescript
// Phase 1: Prepare (validate everything can be done)
const changes = await prepareSyncChanges(ctx, input);
await validateAllChangesCanApply(changes);

// Phase 2: Commit DB in transaction
await withTransaction(ctx.db, async (tx) => {
  await applyChanges(tx, changes);
  // Transaction commits here
});

// Phase 3: Commit to sheets (with retry and compensation)
try {
  await pushToSheets(changes);
  await updateLastSyncTimestamp(...);
} catch (error) {
  // Log critical error - requires manual reconciliation
  await logSyncDivergence(ctx.db, sheetId, changes, error);
  throw new AppError("Sync partially completed - manual reconciliation required");
}
```

**Pros:**
- Handles sheet write failures gracefully
- Can retry sheet writes without re-running DB changes
- Audit trail of partial sync failures
- Better error recovery

**Cons:**
- More complex implementation
- Requires sync divergence tracking table
- Manual reconciliation process needed
- Still risk of partial state (DB yes, sheets no)

**Effort**: High (4-5 days)
**Risk**: Low (comprehensive error handling)

---

### Solution 3: Saga Pattern with Compensating Transactions

**Approach**: Track each step, roll back on failure with compensating actions.

```typescript
const saga = new SyncSaga();

try {
  await saga.step('importLocations',
    () => processImportsToApp(...),
    (results) => undoImportsToApp(...)
  );

  await saga.step('deletions',
    () => processAppDeletions(...),
    (results) => undoDeletions(...)
  );

  // ... more steps

  await saga.commit();
} catch (error) {
  await saga.rollback();
  throw error;
}
```

**Pros:**
- Handles distributed transaction (DB + Sheets)
- Can partially complete and retry
- Full audit trail
- Industry-standard pattern

**Cons:**
- Complex implementation (need saga framework)
- Compensating logic is non-trivial (undelete items?)
- Performance overhead
- Overkill for current requirements

**Effort**: Very High (2-3 weeks)
**Risk**: Medium (complex code, many edge cases)

## Recommended Action

**Immediate (This Week)**: Implement Solution 1
- Wrap all DB operations in `withTransaction`
- Add transaction timeout protection (split large syncs into batches if needed)
- Log sheet write failures with full context
- Document manual reconciliation process

**Short-term (Next Month)**: Enhance with aspects of Solution 2
- Add sync divergence tracking table
- Implement automatic retry for sheet writes
- Build admin UI to view and reconcile failed syncs

## Technical Details

**Affected Files:**
- `apps/web/src/server/api/routers/google-sheets.ts` (lines 1440-1598)
- `apps/web/src/server/repo/database-helpers.ts` (ensure transaction helper supports nested calls)

**Database Changes:**
- Create `sync_divergence` table for tracking partial failures:
  ```sql
  CREATE TABLE sync_divergence (
    id UUID PRIMARY KEY,
    sheet_id VARCHAR NOT NULL,
    sync_timestamp TIMESTAMPTZ NOT NULL,
    db_changes JSONB NOT NULL,
    sheet_write_error TEXT,
    status VARCHAR NOT NULL, -- 'pending', 'resolved', 'ignored'
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  ```

**Transaction Timeout Protection:**
- PostgreSQL default: 30 seconds
- AWS RDS default: 60 seconds
- For large syncs (>1000 items), batch into chunks of 100

## Acceptance Criteria

- [ ] All sync database operations wrapped in single transaction
- [ ] Transaction rollback tested for each operation failure point
- [ ] Sheet write failures logged with full context
- [ ] Transaction timeout protection for large syncs (batch processing)
- [ ] Integration test: Import fails → no data committed
- [ ] Integration test: Delete fails → imports rolled back
- [ ] Integration test: Sheets write fails → DB changes committed, divergence logged
- [ ] Manual reconciliation process documented
- [ ] Monitoring alert for sync divergence table entries

## Work Log

### 2026-01-12 - Initial Analysis

**By:** Claude Code Review Agent

**Actions:**
- Identified lack of transaction boundaries in applySync
- Analyzed failure scenarios and data corruption risks
- Designed three solution approaches with tradeoffs

**Findings:**
- Multiple database mutations outside transaction scope
- Sheet writes can fail after DB commits (no rollback)
- Error handling loses context about what succeeded
- Individual operations may use transactions, but no overall atomicity

**Learnings:**
- Transaction boundaries critical for multi-step operations
- Need to handle distributed transaction problem (DB + Sheets)
- Two-phase commit more appropriate than single transaction

## Resources

- Code: `apps/web/src/server/api/routers/google-sheets.ts:1479-1598`
- Related: Issue #001 (race condition) - both need transaction fixes
- Pattern: Saga Pattern - https://microservices.io/patterns/data/saga.html
- Related audit trail code: `apps/web/src/server/repo/audit-log/` (already has transaction support)

## Notes

This issue is **CRITICAL** and blocks production deployment. Every sync failure will corrupt data. The immediate fix (Solution 1) can be implemented quickly and provides significant safety.

The deeper issue is the impedance mismatch between transactional database and eventually-consistent external API (Google Sheets). Long-term, consider:
1. Event sourcing pattern (record intent, apply changes, handle failures)
2. Sync queue with retry logic
3. Admin UI for manual conflict resolution

Also note: Transaction timeout is a real concern. With 1000 inventory items and N+1 queries (see issue #003 - performance), a single transaction could easily exceed 60 seconds. Must fix performance issues OR implement batching before deploying transaction wrapper.
