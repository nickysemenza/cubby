import { getLocationTypeColor, type LocationType } from "@cubby/shared";
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

// Re-export colors/helpers from @cubby/shared for existing consumers
export { getLocationTypeColor };

/**
 * Location type color groups - color families with within-group variation
 * Groups provide visual recognition, variations provide individual distinction
 */
type LocationTypeGroup = "spaces" | "surfaces" | "storage" | "containers";

/** Groups that get physical QR code labels */
const QR_LABEL_GROUPS: ReadonlySet<LocationTypeGroup> = new Set([
  "surfaces",
  "storage",
  "containers",
]);

/**
 * Whether a location type supports QR code labels.
 * Surfaces, storage, and containers get labels — spaces don't.
 */
export const typeSupportsQrCode = (type: LocationType): boolean =>
  QR_LABEL_GROUPS.has(typeToGroup[type]);

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
  "quarter-crate": "containers",
  "milk-crate": "containers",
  "tote-bin": "containers",
  bag: "containers",
};

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
    case "quarter-crate":
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
