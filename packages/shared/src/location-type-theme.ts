// Location type values - single source of truth for both Zod and Drizzle
export const locationTypeValues = [
  "room",
  "area",
  "bag",
  "box",
  "shelf",
  "crate",
  "half-crate",
  "quarter-crate",
  "milk-crate",
  "tote-bin",
  "table",
  "drawer",
  "cart",
  "cabinet",
] as const;

export type LocationType = (typeof locationTypeValues)[number];

/**
 * Location type colors - warm-anchored color families with variations.
 * Each group keeps a distinct earthy hue; items vary by lightness/chroma.
 * Tuned to harmonize with the app's warm palette (no cold cyan/lime).
 */
export const locationTypeColors: Record<LocationType, string> = {
  // Spaces group (warm brown family)
  room: "oklch(0.5 0.08 50)", // base
  area: "oklch(0.6 0.06 52)", // lighter/muted

  // Surfaces group (olive-sage family)
  table: "oklch(0.58 0.08 135)", // base
  cart: "oklch(0.64 0.09 130)", // brighter
  shelf: "oklch(0.5 0.06 138)", // muted/darker

  // Storage group (warm plum-rose family)
  cabinet: "oklch(0.55 0.11 350)", // base
  drawer: "oklch(0.62 0.12 352)", // lighter

  // Containers group (muted warm teal family)
  box: "oklch(0.58 0.07 200)", // base
  crate: "oklch(0.52 0.06 202)", // darker
  "half-crate": "oklch(0.62 0.07 198)", // slightly lighter
  "quarter-crate": "oklch(0.6 0.07 199)", // between crate and half-crate
  "milk-crate": "oklch(0.68 0.07 196)", // lighter
  "tote-bin": "oklch(0.54 0.05 202)", // muted
  bag: "oklch(0.64 0.08 195)", // brighter
};

/**
 * Get the color for a location type
 */
export const getLocationTypeColor = (type: LocationType): string =>
  locationTypeColors[type];
