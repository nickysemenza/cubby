/**
 * What a location IS, for the locations that aren't a product.
 *
 * Seven values retired in 2026-08 — `crate`, `half-crate`, `quarter-crate`,
 * `milk-crate` and the three `tote-*` sizes. They were never a taxonomy: each
 * named a SKU you can buy, which is a fact about the product and not about the
 * bin. Those locations now carry `location.productId` and no type at all, so
 * the size lives on the Product where correcting it fixes every bin at once.
 *
 * What remains is genuine structure plus the generic vessels — a `box` with no
 * Product is a real cardboard box nobody catalogued.
 */
export const locationTypeValues = [
  "house",
  "room",
  "area",
  "bag",
  "box",
  "shelf",
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
  house: "var(--chart-1)",
  room: "var(--chart-1)",
  area: "var(--chart-2)",

  table: "var(--chart-3)",
  cart: "var(--chart-4)",
  shelf: "var(--chart-2)",

  cabinet: "var(--chart-5)",
  drawer: "var(--chart-6)",

  box: "var(--chart-6)",
  bag: "var(--chart-8)",
};

/**
 * A location linked to a Product carries no `type` of its own — the SKU is its
 * form factor — so every theme lookup has to answer for null. The fallback is
 * the container rung: a linked location is always a vessel, never a room.
 */
const CONTAINER_FALLBACK_COLOR = "var(--chart-7)";

export const getLocationTypeColor = (type: LocationType | null): string =>
  type ? locationTypeColors[type] : CONTAINER_FALLBACK_COLOR;
