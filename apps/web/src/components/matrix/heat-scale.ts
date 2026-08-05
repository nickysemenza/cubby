// The shared heat scale for cross-tab cells. One scale so every matrix that
// shades by magnitude reads the same way.
//
// Cell padding/typography lives in ./matrix-chrome — this module is only about
// heat, so a matrix can shade without adopting the chrome, or vice versa.

export type HeatBucket = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Bucket a value against a max on a sqrt-scaled ratio (like Sheets' color
 * scale). The sqrt matters because the quantities these grids hold — dollar
 * sums, ingredient weights — are heavy-tailed: on a linear ramp one outlier
 * flattens every other cell to the palest bucket.
 *
 * What `max` should be is the caller's decision and it is not always the grid
 * max. Shade against the grid when every cell shares a unit (dollars); shade
 * per row when they don't (500 g flour vs. 2 eggs), or the ramp just encodes
 * which unit is numerically larger.
 */
export function heatBucket(value: number, max: number): HeatBucket {
  if (value <= 0 || max <= 0) return 0;
  const t = Math.sqrt(value / max);
  if (t >= 0.85) return 5;
  if (t >= 0.6) return 4;
  if (t >= 0.35) return 3;
  if (t >= 0.15) return 2;
  return 1;
}

export const HEAT_CLASSES: Record<HeatBucket, string> = {
  0: "",
  1: "bg-chart-seq-1",
  2: "bg-chart-seq-2",
  3: "bg-chart-seq-3",
  4: "bg-chart-seq-4 text-background", // deep fills flip to paper ink
  5: "bg-chart-seq-5 text-background",
};
