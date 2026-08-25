import { cva, type VariantProps } from "class-variance-authority";

/**
 * Layout-primitive cvas — the single home for the app's spacing vocabulary.
 *
 * Named `gap` scale (Tailwind spacing units → 0.25rem each):
 *
 *   tight = 0.5   snug = 1.5   xs = 1   sm = 2   md = 4   lg = 6
 *
 * `tight` / `snug` are the two blessed sub-scale densities (icon+label rows,
 * dense list cells). Dense UI uses these named variants instead of scattering
 * one-off sub-scale classes across pages.
 *
 * Consumed by the Row / Grid / Stack / Section primitives in
 * ~/components/layout. Pages should reach for those, not raw flex/grid/space-y.
 */

/** Shared `gap-*` scale used by Row and Grid. */
const GAP = {
  tight: "gap-0.5",
  snug: "gap-1.5",
  xs: "gap-1",
  sm: "gap-2",
  md: "gap-4",
  lg: "gap-6",
} as const;

/**
 * Horizontal flex row. No default variants — a bare `<Row>` is just `flex`
 * (faithful to the old FlexContainer), so callers opt into alignment/gap.
 */
export const rowVariants = cva("flex", {
  variants: {
    align: {
      start: "items-start",
      center: "items-center",
      end: "items-end",
      baseline: "items-baseline",
      stretch: "items-stretch",
    },
    justify: {
      start: "justify-start",
      center: "justify-center",
      end: "justify-end",
      between: "justify-between",
      around: "justify-around",
    },
    wrap: {
      true: "flex-wrap",
    },
    gap: GAP,
  },
});

/** Responsive card/thumbnail grid. Defaults to `gap-4` (md). */
export const gridVariants = cva("grid", {
  variants: {
    cols: {
      pair: "grid-cols-1 lg:grid-cols-2",
      cards3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
      thumbs: "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5",
      images: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5",
      // auto-fit stretches the present metrics to fill the row (4 for recipe/
      // inventory, up to 6 for nutrition) instead of pinning to 8 fixed columns
      // and leaving dead space; the 7rem floor wraps to 2–3 across on mobile.
      summary: "grid-cols-[repeat(auto-fit,minmax(7rem,1fr))]",
    },
    gap: GAP,
  },
  defaultVariants: {
    gap: "md",
  },
});

/**
 * Vertical stack. `flex flex-col` + `space-y-*` (not `gap-*`, to keep the
 * named `gap` scale's classes stable) — the base can't be plain block: a bare
 * `div` with `space-y-*` only inserts `margin-top` on non-first children,
 * and inline elements (`span`, `a`, …) ignore vertical margin, so two inline
 * children run together on one line with no visible separation. `flex-col`
 * blockifies every child (per CSS flex-item blockification), which is what
 * actually forces the line break; `space-y-*` still works unmodified on
 * blockified children since margins apply normally to flex items. Defaults
 * to `space-y-4` (md). Already-block children (`div`, `p`, `Row`, …) that
 * relied on filling the container's width are unaffected — they already did
 * under plain block layout, and `flex-col`'s default `align-items: stretch`
 * reproduces that. The exception is a child whose own `display` is
 * `inline-flex`/`inline-block` with no explicit width (a bare `Button`,
 * `EntityInlineLink`, …) — it now stretches to the container's width instead
 * of shrinking to its content, where before it kept its natural size.
 */
export const stackVariants = cva("flex flex-col", {
  variants: {
    gap: {
      tight: "space-y-0.5",
      snug: "space-y-1.5",
      xs: "space-y-1",
      sm: "space-y-2",
      md: "space-y-4",
      lg: "space-y-6",
    },
  },
  defaultVariants: {
    gap: "md",
  },
});

export type RowVariants = VariantProps<typeof rowVariants>;
export type GridVariants = VariantProps<typeof gridVariants>;
export type StackVariants = VariantProps<typeof stackVariants>;
