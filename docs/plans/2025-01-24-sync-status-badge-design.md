# Sync Status Badge Design

## Overview

Add a live sync status indicator to the navbar showing drift between app data and Google Sheets. Provides at-a-glance visibility into sync status without navigating to inventory.

## Visual Design

**Placement:** Before theme toggle in navbar right section

**Badge states:**

| State | Display | Color | Meaning |
|-------|---------|-------|---------|
| In sync | `✓` | Gray | Everything matches |
| Drift, no action needed | `3` | Green | 3 differences, all auto-resolvable (renames) |
| Drift, needs action | `5 · 2` | Orange | 5 total, 2 need decisions |
| Loading | `↻` spinning | Gray | Fetching... |
| Not connected | `⚠` | Gray | Sheet not linked |

**Two-number format:** `total · actionNeeded`
- Total = all non-matched items (conflicts + app_only + sheet_only + renamed + moved)
- Action needed = items requiring user decision (conflicts + app_only + sheet_only)

**Desktop tooltip:** Shows breakdown on hover, e.g., "2 conflicts, 1 app-only, 2 renames — Click to sync"

## Data Fetching

**Reuse existing `syncPreview` endpoint** - no new backend code needed.

Extract counts from preview result:
```typescript
{
  locations: { matched, conflicts, appOnly, sheetOnly, renamed },
  inventory: { matched, conflicts, appOnly, sheetOnly, renamed, moved },
}
```

**Caching strategy:**
- Fetch on app mount
- Refetch when navigating to inventory page
- Refetch after applying sync
- Manual refetch via badge click when stale
- staleTime: 5 minutes

## Component Architecture

```
apps/web/src/app/_components/sync/
├── sync-status-badge.tsx    ← New navbar badge
├── use-sync-preview.ts      ← Shared hook for preview data
└── omnidirectional-sync.tsx ← Existing dialog (modified to use shared hook)
```

**Shared hook `useSyncPreview`:**
- Both badge and dialog consume the same cached preview
- Badge extracts counts
- Dialog uses full items
- One fetch serves both, no duplicate requests

**MainNav integration:**
```tsx
<FlexContainer align="center" gap={4}>
  <SyncStatusBadge />
  <ThemeToggle />
  ...
</FlexContainer>
```

## Interaction Flow

1. App loads → badge shows loading spinner → settles to count/state
2. Hover (desktop) → tooltip with breakdown
3. Click → opens OmnidirectionalSync dialog with pre-loaded data
4. Apply sync → dialog closes → badge refetches → updates to new state

## Edge Cases

| Scenario | Badge shows | Behavior |
|----------|-------------|----------|
| Sheet not configured | Hidden | Badge not rendered |
| Configured but not connected | `⚠` gray | Click navigates to settings/integrations |
| Fetch error | `⚠` gray | Tooltip: "Couldn't check sync status" |
| Stale data (>5 min) | Normal, dimmed | Tooltip adds "Last checked Xm ago" |
| Everything in sync | `✓` | Gray checkmark, no numbers |

## Mobile

- Same badge with colors
- Tap opens dialog directly (no hover tooltip)
- Badge also appears in mobile slide-out menu
