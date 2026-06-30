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
  "tote-27gal": "containers",
  "tote-14gal": "containers",
  "tote-7gal": "containers",
  bag: "containers",
};

/**
 * Get the group for a location type (useful for logic based on grouping)
 */
export const getLocationTypeGroup = (type: LocationType): LocationTypeGroup =>
  typeToGroup[type];

// Exhaustive at construction: a new LocationType without a key here is a compile
// error (replaces the old assertNever default-case guarantee).
const locationIcons: Record<LocationType, LucideIcon> = {
  room: Home,
  area: LayoutGrid,
  bag: ShoppingBag,
  shelf: Layers,
  crate: Box,
  "half-crate": Box,
  "quarter-crate": Box,
  "milk-crate": Box,
  "tote-27gal": Box,
  "tote-14gal": Box,
  "tote-7gal": Box,
  table: Table2,
  drawer: FileBox,
  cart: ShoppingCart,
  cabinet: Box,
  box: Box,
};

/**
 * Get the icon component for a location type
 */
export const getLocationIcon = (type: LocationType): LucideIcon =>
  locationIcons[type]; // safe: complete Record keyed by the enum
