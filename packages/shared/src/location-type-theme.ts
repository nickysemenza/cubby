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
 * Location type colors - color families with variations
 * Each group has a base hue, items vary by lightness/saturation
 */
export const locationTypeColors: Record<LocationType, string> = {
  // Spaces group (warm brown family)
  room: "hsl(25, 50%, 45%)", // base
  area: "hsl(25, 40%, 55%)", // lighter/muted

  // Surfaces group (lime green family)
  table: "hsl(100, 45%, 45%)", // base
  cart: "hsl(100, 55%, 50%)", // brighter
  shelf: "hsl(100, 35%, 40%)", // muted/darker

  // Storage group (rose/pink family)
  cabinet: "hsl(330, 45%, 50%)", // base
  drawer: "hsl(330, 55%, 55%)", // lighter

  // Containers group (cyan family)
  box: "hsl(190, 50%, 45%)", // base
  crate: "hsl(190, 45%, 40%)", // darker
  "half-crate": "hsl(190, 50%, 50%)", // slightly lighter
  "quarter-crate": "hsl(190, 48%, 48%)", // between crate and half-crate
  "milk-crate": "hsl(190, 55%, 55%)", // lighter
  "tote-bin": "hsl(190, 40%, 42%)", // muted
  bag: "hsl(190, 60%, 52%)", // brighter
};

/**
 * Get the color for a location type
 */
export const getLocationTypeColor = (type: LocationType): string =>
  locationTypeColors[type];
