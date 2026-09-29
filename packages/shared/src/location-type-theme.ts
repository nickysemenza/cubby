/**
 * What a location IS.
 *
 * Seven values retired in 2026-08 — `crate`, `half-crate`, `quarter-crate`,
 * `milk-crate` and the three `tote-*` sizes. They were never a taxonomy: each
 * named a SKU you can buy, which is a fact about the product and not about the
 * bin. Those locations carry `location.productId` and the explicit type
 * `furniture`, so the size lives on the Product where correcting it fixes
 * every bin at once. `furniture` is only valid with a `productId` (a CHECK on
 * the column); the converse does not hold — a garden bed or planter may also
 * link a Product and keeps its own type.
 *
 * What remains is genuine structure plus the generic vessels — a `box` with no
 * Product is a real cardboard box nobody catalogued.
 */
export const locationTypeValues = [
  "house",
  "room",
  "area",
  "bed",
  "planter",
  "bag",
  "box",
  "shelf",
  "table",
  "drawer",
  "cart",
  "cabinet",
  "furniture",
] as const;

export type LocationType = (typeof locationTypeValues)[number];

/**
 * Location type colors — Warm-Paper Ledger. Drawn from the app's
 * retoned categorical chart ramp: the lone ultramarine (chart-1) for the
 * top-level "room", then the monochrome ink ladder (chart-2..8) for everything
 * else. Grouped families share a rung so related types read together; matte,
 * off the warm axis, distinguished by value not hue.
 */
export const locationTypeColors = {
  house: "var(--chart-1)",
  room: "var(--chart-1)",
  area: "var(--chart-2)",
  bed: "var(--chart-2)",

  table: "var(--chart-3)",
  cart: "var(--chart-4)",
  shelf: "var(--chart-2)",
  planter: "var(--chart-4)",

  cabinet: "var(--chart-5)",
  drawer: "var(--chart-6)",

  box: "var(--chart-6)",
  bag: "var(--chart-8)",
  furniture: "var(--chart-7)",
} as const satisfies Record<LocationType, string>;

/**
 * A location linked to a Product carries no `type` of its own — the SKU is its
 * form factor — so every theme lookup has to answer for null. The fallback is
 * the container rung: a linked location is always a vessel, never a room.
 */
const CONTAINER_FALLBACK_COLOR = "var(--chart-7)";

export const getLocationTypeColor = (type: LocationType | null): string =>
  type ? locationTypeColors[type] : CONTAINER_FALLBACK_COLOR;
