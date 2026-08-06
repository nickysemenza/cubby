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
  "tote-27gal",
  "tote-14gal",
  "tote-7gal",
  "table",
  "drawer",
  "cart",
  "cabinet",
] as const;

export type LocationType = (typeof locationTypeValues)[number];

/**
 * Location type colors — Warm-Paper Ledger (2026-06-25). Drawn from the app's
 * retoned categorical chart ramp: the lone ultramarine (chart-1) for the
 * top-level "room", then the monochrome ink ladder (chart-2..8) for everything
 * else. Grouped families share a rung so related types read together; matte,
 * off the warm axis, distinguished by value not hue.
 */
export const locationTypeColors: Record<LocationType, string> = {
  room: "var(--chart-1)", // top-level space gets the accent
  area: "var(--chart-2)",

  table: "var(--chart-3)",
  cart: "var(--chart-4)",
  shelf: "var(--chart-2)",

  cabinet: "var(--chart-5)",
  drawer: "var(--chart-6)",

  box: "var(--chart-6)",
  crate: "var(--chart-7)",
  "half-crate": "var(--chart-7)",
  "quarter-crate": "var(--chart-7)",
  "milk-crate": "var(--chart-8)",
  "tote-27gal": "var(--chart-7)",
  "tote-14gal": "var(--chart-7)",
  "tote-7gal": "var(--chart-7)",
  bag: "var(--chart-8)",
};

export const getLocationTypeColor = (type: LocationType): string =>
  locationTypeColors[type];
