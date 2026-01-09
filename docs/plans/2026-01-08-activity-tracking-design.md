# Activity Tracking Design

Track recurring and ad-hoc activities performed on products (maintenance, cleaning, inspections, etc.).

## Overview

"Activities" are things you do to products, sometimes on a schedule:
- Maintenance: oil change, descale, replace filter
- Cleaning: wash skylights, vacuum coils
- Inspections: check tire pressure, test smoke detector
- Consumable replacement: new furnace filter, water filter cartridge

The system logs when activities are completed and optionally tracks when they're next due.

## Data Model

### Tables

```sql
CREATE TABLE activity_type (
  id TEXT PRIMARY KEY DEFAULT nanoid(),
  product_id TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  interval_days INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(product_id, name)
);

CREATE TABLE activity_entry (
  id TEXT PRIMARY KEY DEFAULT nanoid(),
  activity_type_id TEXT NOT NULL REFERENCES activity_type(id) ON DELETE CASCADE,
  completed_at TIMESTAMP NOT NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE activity_entry_image (
  activity_entry_id TEXT NOT NULL REFERENCES activity_entry(id) ON DELETE CASCADE,
  image_id TEXT NOT NULL REFERENCES image(id) ON DELETE CASCADE,
  PRIMARY KEY (activity_entry_id, image_id)
);

CREATE INDEX idx_activity_type_product ON activity_type(product_id);
CREATE INDEX idx_activity_entry_type ON activity_entry(activity_type_id);
CREATE INDEX idx_activity_entry_completed ON activity_entry(completed_at DESC);
```

### Entity Relationships

```
Product (existing)
    │
    │ 1:many
    ▼
ActivityType
    │  - name: "Oil Change", "Descale", etc.
    │  - intervalDays: null for event-based, number for scheduled
    │
    │ 1:many
    ▼
ActivityEntry
    │  - completedAt: when activity was performed
    │  - notes: optional free text
    │
    │ many:many
    ▼
Image (existing, via activity_entry_image join)
```

### Computed Fields

- `lastCompletedAt` = most recent entry's `completedAt`
- `nextDueAt` = `lastCompletedAt + intervalDays` (null if no interval or no entries)
- `isOverdue` = `nextDueAt < now`
- `isDueSoon` = `nextDueAt < now + 14 days`

### Branded IDs

```typescript
// ~/schemas/identifiers.ts
export type ActivityTypeId = string & { readonly __brand: "ActivityTypeId" };
export type ActivityEntryId = string & { readonly __brand: "ActivityEntryId" };

export const unsafeActivityTypeId = (id: string) => id as ActivityTypeId;
export const unsafeActivityEntryId = (id: string) => id as ActivityEntryId;

export const activityTypeId = z.string().transform(unsafeActivityTypeId);
export const activityEntryId = z.string().transform(unsafeActivityEntryId);
```

## "Loose Enum" Autocomplete

Activity type names behave like a loose enum with autocomplete:

1. User selects product (or is viewing one)
2. User types activity name in combobox
3. System queries existing `activity_type` names for that product
4. If match selected → use existing type
5. If new name → create new `activity_type` on the fly
6. Optional: set interval if it recurs on a schedule

This gives natural convergence without forcing predefined categories.

## UI Routes & Views

### `/activities` - Dashboard

Primary view with three sections:

**Overdue** (red)
- Activities where `nextDueAt < now`
- Sorted by most overdue first

**Due Soon** (amber)
- Activities where `nextDueAt` is within 14 days
- Sorted by due date

**Recently Completed** (neutral)
- Last 30 days of completed activities
- For reference

Each item shows: Product name, Activity name, Due/completed date

**Calendar Toggle:**
- Month view with dots on days with activities due
- Click day to see what's due

### Product Detail → Activities Tab

New tab on existing product page:

- List of activity types for this product
- Each type shows: name, interval, last completed, next due
- Expand type to see entry history
- "Log Activity" button opens entry form

### Log Activity Form

- Product (pre-selected if on product page)
- Activity name (combobox with autocomplete)
- Completed at (defaults to now)
- Notes (optional textarea)
- Photo upload (optional, multiple)
- Interval prompt: "Does this repeat?" → days input

## Problems Dashboard Integration

Add to existing `/problems` page:

**"Overdue Activities"** problem type:
- Count of activities where `nextDueAt < now`
- Expandable list showing product + activity + days overdue
- Click navigates to product's activities tab

## Google Sheets Sync

### Sheet Structure

Single sheet with entries, product code for matching:

| Product Code | Product Name | Activity | Completed At | Notes | Interval (days) |
|--------------|--------------|----------|--------------|-------|-----------------|
| CIVIC-2019 | 2019 Honda Civic | Oil Change | 2024-01-15 | Mobil 1 synthetic | 90 |
| CIVIC-2019 | 2019 Honda Civic | Oil Change | 2024-04-20 | Mobil 1 synthetic | |
| COFFEE-BREVILLE | Breville Coffee Machine | Descale | 2024-03-01 | Light was blinking | |

- **Product Code** - Required, used for matching
- **Product Name** - Display only, auto-filled on export
- **Activity** - Activity type name
- **Completed At** - Entry timestamp
- **Notes** - Optional
- **Interval (days)** - Optional, updates activity type when present

### Import Logic

1. Look up product by shortcode
2. Find or create activity type by (productId + name)
3. If interval provided, update activity type's interval
4. Upsert entry by (activityTypeId + completedAt)

### Export Logic

1. Query all activity entries with product and type info
2. Write to sheet with product code, name, activity, timestamp, notes
3. Include interval on first row for each activity type

## API Layer

### `activityType` Router

```typescript
activityType.list({ productId })
// Returns activity types for a product with computed due status

activityType.listDue({ overdue?: boolean, dueSoonDays?: number })
// Returns all due/overdue activities across all products

activityType.create({ productId, name, intervalDays? })
// Creates new activity type

activityType.update({ id, name?, intervalDays? })
// Updates activity type

activityType.delete({ id })
// Deletes type and all entries (with confirmation)

activityType.autocomplete({ productId, query })
// Returns matching type names for autocomplete
```

### `activityEntry` Router

```typescript
activityEntry.list({ activityTypeId, pagination })
// Paginated entries for a type, sorted by completedAt desc

activityEntry.create({ activityTypeId, completedAt, notes?, imageIds? })
// Creates new entry

activityEntry.update({ id, completedAt?, notes? })
// Updates entry

activityEntry.delete({ id })
// Removes entry
```

### `activitySheets` Router

```typescript
activitySheets.export({ spreadsheetId })
// Exports all activities to Google Sheet

activitySheets.import({ spreadsheetId })
// Imports activities from Google Sheet
```

## Repository Layer

```typescript
// activity-type-repo.ts
export const activityTypeRepo = {
  list: (db: Database, productId: ProductId) => {...},
  listDue: (db: Database, opts: { overdue?: boolean, dueSoonDays?: number }) => {...},
  findByProductAndName: (db: Database, productId: ProductId, name: string) => {...},
  autocomplete: (db: Database, productId: ProductId, query: string) => {...},
  create: (db: Database, data: CreateActivityType) => {...},
  update: (db: Database, id: ActivityTypeId, data: UpdateActivityType) => {...},
  delete: (db: Database, id: ActivityTypeId) => {...},
}

// activity-entry-repo.ts
export const activityEntryRepo = {
  list: (db: Database, activityTypeId: ActivityTypeId, pagination: Pagination) => {...},
  create: (db: Database, data: CreateActivityEntry) => {...},
  update: (db: Database, id: ActivityEntryId, data: UpdateActivityEntry) => {...},
  delete: (db: Database, id: ActivityEntryId) => {...},
  getLatestByType: (db: Database, activityTypeId: ActivityTypeId) => {...},
  findByTypeAndTimestamp: (db: Database, activityTypeId: ActivityTypeId, completedAt: Date) => {...},
}
```

## Audit Trail

Uses existing audit log pattern:
- `entityType: "activity_type"` or `"activity_entry"`
- Captures create, update, delete
- Visible in `/activity` route

## Not in v1

- External notifications (email, push)
- Cost tracking as dedicated field (use notes)
- Mileage/counter as dedicated field (use notes)
- Bulk operations
- Sharing activity types across products
- Photos on export (just entries)

## Summary

| Component | Location |
|-----------|----------|
| Schema | `apps/web/src/server/db/schema.ts` |
| Branded IDs | `apps/web/src/schemas/identifiers.ts` |
| Repos | `apps/web/src/server/repo/activity-type-repo.ts`, `activity-entry-repo.ts` |
| Routers | `apps/web/src/server/api/routers/activity-type.ts`, `activity-entry.ts`, `activity-sheets.ts` |
| Dashboard | `apps/web/src/routes/activities.tsx` |
| Product Tab | `apps/web/src/routes/products.$id.tsx` (new tab) |
| Problems | `apps/web/src/server/api/routers/problems.ts` (add overdue query) |
