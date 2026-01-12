---
status: pending
priority: p1
issue_id: "003"
tags: [google-sheets, performance, n-plus-1, database, optimization]
dependencies: []
---

# N+1 Query Pattern in CSV Import

## Problem Statement

The CSV import loop processes each row sequentially with individual database lookups, creating an N+1 query problem. For 1,000 inventory items, this results in **3,000-7,000 database round trips**, taking 100-300 seconds to complete.

Each `processRow` makes 3-7 queries:
1. Find product by name+manufacturer
2. Find location by name/shortcode
3. Check if inventory exists
4. Get existing inventory locations
5. Create/update product (if needed)
6. Create/update inventory (if needed)
7. Check/update unit mappings

**Location**: `/apps/web/src/server/repo/inventory/csv-import/row-processor.ts:66-142`

**Severity**: CRITICAL - Performance breaks down at 500+ items, making sync unusable for medium-large datasets.

## Findings

**Performance Profile:**

| Items | DB Queries (Current) | Time (Current) | Queries (Optimized) | Time (Optimized) |
|-------|---------------------|----------------|---------------------|------------------|
| 100   | 300-700            | 10-30s         | 10-15              | 1-2s             |
| 500   | 1,500-3,500        | 50-150s        | 15-20              | 3-5s             |
| 1,000 | 3,000-7,000        | 100-300s       | 20-25              | 5-8s             |
| 5,000 | 15,000-35,000      | 8-25min        | 30-40              | 15-25s           |

**Code Evidence:**

```typescript
// Line 66-73: Sequential processing (N+1 pattern)
for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const result = await processRow({ db, dryRun, actor }, row, i);
  // ↑ Each call makes 3-7 database queries
  items.push(result);
}
```

**Impact:**
- Sync unusable for datasets >500 items
- Database connection pool exhaustion (1000 transactions)
- Transaction timeout risk (PostgreSQL default: 30s)
- Poor user experience (minutes of waiting)
- Blocks fixing issue #002 (transaction wrapper would timeout)

**Related Issues:**
- Same N+1 pattern in location import
- No batching in Google Sheets API calls
- In-memory comparison has O(n²) worst case

## Proposed Solutions

### Solution 1: Batch Lookups with In-Memory Processing (Recommended)

**Approach**: Pre-fetch all data in 3 queries, process rows in-memory, batch upsert results.

```typescript
async function importInventoryFromCSV(db, rows, options) {
  // Step 1: Batch lookup all products (1 query)
  const productKeys = rows.map(r => ({
    name: r.product_name,
    manufacturer: r.manufacturer
  }));
  const productsMap = await batchFindProducts(db, productKeys);

  // Step 2: Batch lookup all locations (1 query)
  const locationNames = [...new Set(rows.map(r => r.location_name))];
  const locationsMap = await batchFindLocations(db, locationNames);

  // Step 3: Batch lookup existing inventory (1 query)
  const productIds = Array.from(productsMap.values()).map(p => p.id);
  const locationIds = Array.from(locationsMap.values()).map(l => l.id);
  const inventoryMap = await batchFindInventory(db, productIds, locationIds);

  // Step 4: Process rows in-memory (no DB calls)
  const productsToCreate = [];
  const productsToUpdate = [];
  const inventoryToCreate = [];
  const inventoryToUpdate = [];

  for (const row of rows) {
    const productKey = makeKey(row.product_name, row.manufacturer);
    const product = productsMap.get(productKey);

    if (!product) {
      productsToCreate.push(buildProductFromRow(row));
    } else if (needsUpdate(product, row)) {
      productsToUpdate.push({ id: product.id, ...buildProductUpdate(row) });
    }

    // ... similar logic for inventory
  }

  // Step 5: Batch upsert in chunks (3-4 queries total)
  await batchUpsertProducts(db, productsToCreate);
  await batchUpdateProducts(db, productsToUpdate);
  await batchUpsertInventory(db, inventoryToCreate);
  await batchUpdateInventory(db, inventoryToUpdate);
}
```

**Pros:**
- 30-100x performance improvement
- Queries reduced from 3,000-7,000 to ~15-20
- Scales to 5,000+ items
- Easier to wrap in transaction (fast enough to avoid timeout)
- More predictable performance

**Cons:**
- More complex code (need batch helpers)
- Higher initial memory usage (all data in RAM)
- Need to handle partial failures differently
- Requires refactoring existing row processor

**Effort**: High (4-5 days)
**Risk**: Medium (large refactor, need comprehensive tests)

---

### Solution 2: Streaming Processing with Batch Size

**Approach**: Process in chunks to balance memory and queries.

```typescript
const BATCH_SIZE = 100;

for (let i = 0; i < rows.length; i += BATCH_SIZE) {
  const batch = rows.slice(i, i + BATCH_SIZE);

  // Batch fetch for this chunk
  const productsMap = await batchFindProducts(db, batch);
  // ... process batch

  // Batch insert/update
  await batchUpsertResults(db, batchResults);
}
```

**Pros:**
- Lower memory footprint
- Can process arbitrarily large files
- Still provides significant speedup
- Easier to implement than full Solution 1

**Cons:**
- Still makes multiple passes (N/100 batches)
- More database round trips than Solution 1
- Transaction per batch (partial failure handling)
- Less performance improvement than Solution 1

**Effort**: Medium (3-4 days)
**Risk**: Low (incremental improvement, keep existing structure)

---

### Solution 3: Database-Side Bulk Insert with Temp Table

**Approach**: Use PostgreSQL COPY or temp tables for bulk operations.

```typescript
// Create temp table
await db.execute(`
  CREATE TEMP TABLE import_staging (
    product_name TEXT,
    manufacturer TEXT,
    location_name TEXT,
    quantity NUMERIC,
    -- ... all fields
  )
`);

// Bulk insert to temp table (fast)
await db.copy(`COPY import_staging FROM STDIN`, csvData);

// Single SQL statement to upsert from staging to products
await db.execute(`
  INSERT INTO products (name, manufacturer, ...)
  SELECT DISTINCT product_name, manufacturer, ...
  FROM import_staging
  ON CONFLICT (name, manufacturer) DO UPDATE ...
`);

// Single SQL statement for inventory
await db.execute(`
  INSERT INTO inventory_entry (product_id, location_id, ...)
  SELECT p.id, l.id, s.quantity, ...
  FROM import_staging s
  JOIN products p ON p.name = s.product_name AND p.manufacturer = s.manufacturer
  JOIN location l ON l.name = s.location_name
  ON CONFLICT (product_id, location_id) DO UPDATE ...
`);
```

**Pros:**
- Fastest possible (database-native bulk operations)
- Minimal memory usage
- Single transaction
- Scales to 10,000+ items

**Cons:**
- Complex SQL statements
- Bypasses application-level validation
- Hard to generate audit log entries per-item
- Difficult to test
- Tightly coupled to PostgreSQL

**Effort**: High (5-7 days)
**Risk**: High (complex SQL, testing difficulty, audit trail issues)

## Recommended Action

**Phase 1 (Immediate - 1 week)**: Implement Solution 2 (Batch Processing)
- Start with batch size of 100
- Create batch lookup helpers
- Maintain existing error handling structure
- Get 10x performance improvement quickly

**Phase 2 (Short-term - 2 weeks)**: Upgrade to Solution 1
- Full batch processing with in-memory maps
- Comprehensive batch upsert operations
- 30-100x performance improvement
- Enable transaction wrapping (issue #002)

**Phase 3 (Long-term - Optional)**: Consider Solution 3 for very large imports
- Only if regular imports exceed 5,000 items
- Requires audit trail redesign
- Build comprehensive test suite first

## Technical Details

**Affected Files:**
- `apps/web/src/server/repo/inventory/csv-import/row-processor.ts` (major refactor)
- `apps/web/src/server/repo/inventory/csv-import/index.ts` (orchestration)
- `apps/web/src/server/repo/location/csv-import.ts` (same N+1 pattern)
- `apps/web/src/server/repo/database-helpers.ts` (add batch helpers)

**New Batch Helpers Needed:**
```typescript
// In database-helpers.ts:
export async function batchFindProducts(
  db: Database,
  keys: Array<{ name: string; manufacturer: string }>
): Promise<Map<string, Product>>

export async function batchFindLocations(
  db: Database,
  names: string[]
): Promise<Map<string, Location>>

export async function batchFindInventory(
  db: Database,
  productIds: ProductId[],
  locationIds: LocationId[]
): Promise<Map<string, InventoryEntry>>

export async function batchUpsertProducts(
  db: Database,
  products: ProductInput[]
): Promise<Product[]>

export async function batchUpsertInventory(
  db: Database,
  entries: InventoryInput[]
): Promise<InventoryEntry[]>
```

**Transaction Implications:**
- Current: 1,000 items = 1,000 transactions (5-10 minutes)
- Optimized: 1,000 items = 1 transaction (5-8 seconds)
- Enables wrapping in transaction for atomicity (issue #002)

## Acceptance Criteria

- [ ] 1,000 inventory items import in <10 seconds
- [ ] Database queries reduced from O(n) to O(1) or O(log n)
- [ ] Memory usage stays under 100MB for 5,000 items
- [ ] All existing validation and error handling preserved
- [ ] Audit trail still logs all changes
- [ ] Integration tests pass with batched operations
- [ ] Performance benchmarks documented
- [ ] Can wrap entire import in single transaction

## Work Log

### 2026-01-12 - Initial Analysis

**By:** Claude Code Performance Review Agent

**Actions:**
- Profiled CSV import operations
- Identified N+1 query pattern in row processor
- Calculated performance impact at scale
- Designed batch processing solution

**Findings:**
- Each row makes 3-7 database queries
- Sequential processing with no batching
- Same pattern in location import
- Transaction timeout risk with current approach

**Learnings:**
- Batch operations essential for import performance
- In-memory processing dramatically faster than per-row queries
- Must preserve audit trail and validation logic

## Resources

- Code: `apps/web/src/server/repo/inventory/csv-import/row-processor.ts:66-142`
- Related: Issue #002 (transaction wrapper requires fast operations)
- Pattern: Bulk Insert Pattern - https://use-the-index-luke.com/sql/dml/insert
- Drizzle batch docs: https://orm.drizzle.team/docs/batch-api

## Notes

This is a **CRITICAL** performance issue that makes the sync feature unusable for real-world datasets. Most users will have 500-2000 inventory items, which currently takes 1-5 minutes to sync.

**Blocking relationship with issue #002**: Cannot wrap sync in transaction until this is fixed, because transaction would timeout. Must fix performance first, then add transaction wrapper.

**Testing strategy**:
1. Create test dataset with 1,000 items
2. Profile current implementation (capture query count, time)
3. Implement batch processing
4. Profile again (should be 30-100x faster)
5. Load test with 5,000 items to verify scalability

**Migration risk**: Low - this is internal refactoring, no API changes. Behavior remains identical, just much faster.
