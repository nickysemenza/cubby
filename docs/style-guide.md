# Style Guide

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

Use these for Warm-Paper Ledger styling. Cubby currently ships a light-only
theme, so these tokens should be treated as the canonical surface colors rather
than theme switches:

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

**Required**: Prefer existing semantic tokens before adding hard-coded colors:

```tsx
// Good - semantic token
className = "text-destructive";
className = "bg-destructive/10";

// Avoid - bypasses the design token system
className = "text-red-600";
```

### Error State Pattern

```tsx
// Full error box
className = "rounded-none border border-destructive/40 bg-destructive/10 p-3 text-destructive";

// Simple error text (prefer semantic token)
className = "text-destructive";
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

## Theme Model

Cubby currently supports one production theme: Warm-Paper Ledger. It is a
light-only matte interface built from CSS custom properties in
`apps/web/src/styles.css`.

Do not add `.dark`, `.terminal`, `dark:`, or `terminal:` styling unless those
themes are rebuilt intentionally across the whole design system.

## Best Practices

1. **Use semantic tokens first** - Fall back to hard-coded colors only for status/data
2. **Avoid theme-only variants** - Use semantic tokens instead of `dark:` or
   `terminal:` branches
3. **Prefer helper components** - FlexContainer/GridContainer for repeated patterns
4. **Extract long classNames** - Move to `@layer components` when >100 chars
5. **Use `cn()` utility** - For merging classNames with conflict resolution
6. **Maintain consistency** - Follow existing patterns in similar components
