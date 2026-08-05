// The shared class vocabulary for every cross-tab / matrix in the app, so the
// shopping matrix, the recipe component grid, the trade pivots and the tool
// matrix read as one instrument rather than four near-identical tables.
//
// Class strings only — no component, no abstraction. `CrossTabTable` composes
// these for the surfaces whose layout it can own; the matrices it deliberately
// doesn't own (tool-matrix-page, RecipeCompareGrid) still import the same
// strings, which is the whole point of keeping this tier separate.

/** Numeric data cell. The substrate for every value in a cross-tab. */
export const cellMono = "px-2 py-2 text-right font-mono text-xs tabular-nums";

/** Denser variant for high-column-count grids where `cellMono` won't fit. */
export const cellMonoDense =
  "px-2 py-1 text-right font-mono text-2xs tabular-nums";

// Two sticky variants, deliberately not collapsed into one. A sticky cell is
// opaque so the scrolling columns pass *behind* it, which means its background
// has to match the surface it sits on — bg-card inside a bordered card,
// bg-background on a bare page. Using one for the other leaves a visible seam
// the moment the user scrolls horizontally.
/** Sticky first column on a card surface (inside a bordered panel). */
export const stickyRowHeaderCard = "sticky left-0 z-10 bg-card";
/** Sticky first column on the bare page background. */
export const stickyRowHeaderPage = "sticky left-0 z-10 bg-background";

/** Header row: mono eyebrow over the 2px ink rule. */
export const headRule = "eyebrow border-primary border-b-2";

/** Body row separator — dashed, so it reads lighter than the head/foot rules. */
export const bodyRule = "border-border border-b border-dashed";

/** Footer row: the closing rule under the body. */
export const footRule = "eyebrow border-primary border-t-2";

/** The trailing rollup column (Total / Need) — the one accented value per row. */
export const totalCell = "font-medium text-primary";

/**
 * A cell the row genuinely has no value for, paired with {@link EMPTY_MARK}.
 * Intentionally dimmer than `text-slate`: this is a placeholder glyph, not
 * readable text, so it sits outside the 3-level text hierarchy.
 */
export const emptyCell = "text-muted-foreground/30";

/** Rendered in a cell with no value — never a `0`, which would read as data. */
export const EMPTY_MARK = "·";
