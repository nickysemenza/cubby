import {
  Box,
  FileBox,
  Home,
  Layers,
  LayoutGrid,
  type LucideIcon,
  ShoppingBag,
  ShoppingCart,
  Table2,
} from "lucide-react";
import { assertNever } from "~/lib/assert";
import type { LocationType } from "~/schemas/location";

/**
 * Location type color groups - color families with within-group variation
 * Groups provide visual recognition, variations provide individual distinction
 */
type LocationTypeGroup = "spaces" | "surfaces" | "storage" | "containers";

const typeToGroup: Record<LocationType, LocationTypeGroup> = {
  // Spaces - large areas (warm brown family)
  room: "spaces",
  area: "spaces",
  // Surfaces - work/display areas (lime green family)
  table: "surfaces",
  cart: "surfaces",
  shelf: "surfaces",
  // Storage - enclosed/built-in (rose/pink family)
  cabinet: "storage",
  drawer: "storage",
  // Containers - portable (cyan family)
  box: "containers",
  crate: "containers",
  "half-crate": "containers",
  "milk-crate": "containers",
  "tote-bin": "containers",
  bag: "containers",
};

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
  "milk-crate": "hsl(190, 55%, 55%)", // lighter
  "tote-bin": "hsl(190, 40%, 42%)", // muted
  bag: "hsl(190, 60%, 52%)", // brighter
};

/**
 * Get the color for a location type
 */
export const getLocationTypeColor = (type: LocationType): string =>
  locationTypeColors[type];

/**
 * Get the group for a location type (useful for logic based on grouping)
 */
export const getLocationTypeGroup = (type: LocationType): LocationTypeGroup =>
  typeToGroup[type];

/**
 * Get the icon component for a location type
 */
export const getLocationIcon = (type: LocationType): LucideIcon => {
  switch (type) {
    case "room":
      return Home;
    case "area":
      return LayoutGrid;
    case "bag":
      return ShoppingBag;
    case "shelf":
      return Layers;
    case "crate":
    case "half-crate":
    case "milk-crate":
    case "tote-bin":
      return Box;
    case "table":
      return Table2;
    case "drawer":
      return FileBox;
    case "cart":
      return ShoppingCart;
    case "cabinet":
    case "box":
      return Box;
    default:
      assertNever(type);
  }
};
