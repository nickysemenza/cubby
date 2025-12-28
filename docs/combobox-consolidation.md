# Combobox Consolidation Opportunity

## Current State

Two combobox implementations exist:

| Component | Location | Library | Used By |
|-----------|----------|---------|---------|
| `DialogCompatibleCombobox` | `app/_components/combobox/combobox-dialog.tsx` | Native DOM (custom) | Form fields via `ComboboxField`, `ComboboxFieldWithSearch` |
| `FilterableCombobox` | `components/ui/combobox.tsx` | `@base-ui/react` | Scanner page, gallery header, data tables |

## Why Two Exist

`DialogCompatibleCombobox` was created to avoid focus-trap conflicts when using comboboxes inside Radix UI Dialogs. The old combobox used cmdk (built on Radix Dialog), creating nested Radix Dialogs with competing focus traps.

**However**: The codebase has since migrated from Radix to Base UI for dialogs. The original problem no longer exists.

## Consolidation Options

### Option A: Keep `DialogCompatibleCombobox` everywhere

- Already has: async search, loading state, `onCreateNew`, generic ID typing
- ~220 lines of custom code to maintain
- Manual accessibility handling
- Works fine, just not using Base UI

### Option B: Consolidate to `FilterableCombobox` (Base UI)

- Uses maintained headless UI library
- Better accessibility built-in
- Consistent with rest of UI stack (Base UI)
- **Needs added**: async `onSearchChange`, `isLoading`, `onCreateNew`, generic ID typing

## Item Interface Difference

```typescript
// DialogCompatibleCombobox
type ComboboxItem<TId> = { id: TId; name: string; icon?: ReactNode }

// FilterableCombobox
type FilterableComboboxItem = { value: string; label: string; icon?: ReactNode }
```

A quick win before full consolidation: unify these interfaces.

## Recommendation

Low priority unless hitting bugs. If consolidating, Option B (Base UI) is cleaner long-term since it aligns with the rest of the component library.
