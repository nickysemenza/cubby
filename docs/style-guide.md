# RecipeHub Style Guide

This document establishes CSS/Tailwind conventions for consistent, maintainable styling across the codebase.

## Spacing Scale

Based on Tailwind's 4px base unit:

| Token          | Value | Use Case                      |
| -------------- | ----- | ----------------------------- |
| `p-1`, `gap-1` | 4px   | Tight spacing (icons, badges) |
| `p-2`, `gap-2` | 8px   | Default element spacing       |
| `p-3`, `gap-3` | 12px  | Card padding, form fields     |
| `p-4`, `gap-4` | 16px  | Section spacing               |
| `p-6`, `gap-6` | 24px  | Major section breaks          |
| `p-8`, `gap-8` | 32px  | Page-level spacing            |

### Standard Patterns

- **Card components**: `p-3` for header/content/footer
- **Form fields**: `space-y-2` between label and input
- **Form sections**: `space-y-4` between fields
- **Button groups**: `gap-2` between buttons

## Color Tokens

### Semantic Colors (Preferred)

Use these for theme-aware styling that works across light/dark/terminal modes:

| Token                                  | Use Case                        |
| -------------------------------------- | ------------------------------- |
| `text-foreground` / `bg-background`    | Default text/background         |
| `text-muted-foreground` / `bg-muted`   | Secondary text, disabled states |
| `text-primary` / `bg-primary`          | Brand, CTAs                     |
| `text-destructive` / `bg-destructive`  | Error messages, delete actions  |
| `text-accent-foreground` / `bg-accent` | Hover states, highlights        |

### When to Use Hard-coded Colors

Hard-coded colors (e.g., `text-red-600`) are acceptable for:

1. **Status indicators** (red=error, green=success, yellow=warning)
2. **Data visualization** (charts, progress bars)
3. **Semantic values** (positive/negative changes)

**Required**: Always include dark mode variants when using hard-coded colors:

```tsx
// Good - includes dark mode
className = 'text-red-600 dark:text-red-400';
className = 'bg-red-50 dark:bg-red-950';

// Bad - no dark mode
className = 'text-red-600';
```

### Error State Pattern

```tsx
// Full error box
className =
  'rounded border border-red-200 bg-red-50 p-3 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300';

// Simple error text (prefer semantic token)
className = 'text-destructive';
```

## Component Patterns

### When to Use Each Approach

| Approach            | Use Case                  | Example                                  |
| ------------------- | ------------------------- | ---------------------------------------- |
| Raw Tailwind        | One-off styling           | `className="mt-4"`                       |
| `FlexContainer`     | Repeated flex patterns    | `<FlexContainer align="center" gap={2}>` |
| `GridContainer`     | Grid layouts              | `<GridContainer cols="cards3">`          |
| `SpacedContainer`   | Vertical stacked content  | `<SpacedContainer space={4}>`            |
| CVA                 | Components with variants  | Button, Badge                            |
| `@layer components` | Complex selector patterns | `.animate-popover`                       |

### Layout Helper Components

Located in `~/components/ui/`:

```tsx
// FlexContainer - replaces inline flex patterns
<FlexContainer align="center" justify="between" gap={2}>
  <span>Label</span>
  <Button>Action</Button>
</FlexContainer>

// GridContainer - responsive grids
<GridContainer cols="cards3" gap={4}>
  {items.map(item => <Card key={item.id} />)}
</GridContainer>

// SpacedContainer - vertical spacing
<SpacedContainer space={4}>
  <Section1 />
  <Section2 />
</SpacedContainer>
```

### FlexContainer Variants

```ts
direction: 'row' | 'col';
align: 'start' | 'center' | 'end' | 'stretch';
justify: 'start' | 'center' | 'end' | 'between' | 'around';
gap: 0 | 1 | 2 | 3 | 4 | 6 | 8;
wrap: true | false;
```

## Extracted CSS Classes

Located in `~/styles/globals.css` under `@layer components`:

| Class                    | Use Case                                           |
| ------------------------ | -------------------------------------------------- |
| `.animate-popover`       | Popover/dropdown animation states                  |
| `.svg-child-defaults`    | Consistent SVG styling in interactive elements     |
| `.menu-item-base`        | Base styles for dropdown/select/context menu items |
| `.command-dialog-styles` | Command palette cmdk child selectors               |

## CVA (Class Variance Authority)

### Button Variants

```ts
variant: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
size: 'default' | 'sm' | 'lg' | 'icon';
pop: true | false; // adds ring and hover lift
```

### Badge Variants

```ts
variant: 'default' | 'secondary' | 'destructive' | 'outline';
```

## Text Sizes

Prefer standard Tailwind scale:

| Class       | Size | Use Case               |
| ----------- | ---- | ---------------------- |
| `text-xs`   | 12px | Small labels, metadata |
| `text-sm`   | 14px | Default body text      |
| `text-base` | 16px | Larger body text       |
| `text-lg`   | 18px | Subheadings            |

### Documented Exceptions

- `text-[10px]` - Badge text (intentionally compact)
- `text-[11px]` - Button text (dense UI)

## Dark Mode

All components support three themes via CSS custom properties:

- Light (Catppuccin Latte)
- Dark (Catppuccin Frappe)
- Terminal (NeoHtop warm cream)

### Implementation

- Themes are applied via class on `<html>`: `.dark`, `.terminal`
- Use Tailwind's `dark:` prefix for dark-mode-specific styles
- Terminal theme uses `terminal:` custom variant

## Best Practices

1. **Use semantic tokens first** - Fall back to hard-coded colors only for status/data
2. **Always include dark mode** - When using hard-coded colors
3. **Prefer helper components** - FlexContainer/GridContainer for repeated patterns
4. **Extract long classNames** - Move to `@layer components` when >100 chars
5. **Use `cn()` utility** - For merging classNames with conflict resolution
6. **Maintain consistency** - Follow existing patterns in similar components
