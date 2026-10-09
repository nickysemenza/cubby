import type { ProductCategory } from "@cubby/shared/category-theme";
import {
  getLocationTypeColor,
  type LocationType,
} from "@cubby/shared/location-type-theme";
import { CubeIcon } from "@phosphor-icons/react/dist/csr/Cube";
import { FileArchiveIcon } from "@phosphor-icons/react/dist/csr/FileArchive";
import { FlowerIcon } from "@phosphor-icons/react/dist/csr/Flower";
import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";
import { PackageIcon } from "@phosphor-icons/react/dist/csr/Package";
import { PlantIcon } from "@phosphor-icons/react/dist/csr/Plant";
import { ShoppingBagIcon } from "@phosphor-icons/react/dist/csr/ShoppingBag";
import { ShoppingCartIcon } from "@phosphor-icons/react/dist/csr/ShoppingCart";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { StackIcon } from "@phosphor-icons/react/dist/csr/Stack";
import { TableIcon } from "@phosphor-icons/react/dist/csr/Table";
import type { Icon } from "@phosphor-icons/react/lib";

import { getCategoryIcon } from "../products/category-theme";

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
 * Whether a location supports QR code labels.
 * Surfaces, storage, and containers get labels — spaces don't.
 *
 * `furniture` (an instance of a Product) is by definition a physical vessel
 * you can stick a label on, so it always qualifies; so does a type-less hint.
 */
export const typeSupportsQrCode = (type: LocationType | null): boolean =>
  type === null || QR_LABEL_GROUPS.has(typeToGroup[type]);

const typeToGroup = {
  // Spaces - large areas (warm brown family)
  house: "spaces",
  room: "spaces",
  area: "spaces",
  // Surfaces - work/display areas (lime green family)
  table: "surfaces",
  cart: "surfaces",
  shelf: "surfaces",
  bed: "surfaces",
  // A Product instance is a portable vessel (the bin, tote or rack itself).
  furniture: "containers",
  // Storage - enclosed/built-in (rose/pink family)
  cabinet: "storage",
  drawer: "storage",
  // Containers - portable (cyan family)
  box: "containers",
  bag: "containers",
  planter: "containers",
} satisfies Record<LocationType, LocationTypeGroup>;

/**
 * Get the group for a location type (useful for logic based on grouping)
 */
export const getLocationTypeGroup = (
  type: LocationType | null,
): LocationTypeGroup => (type ? typeToGroup[type] : "containers");

// Exhaustive at construction: a new LocationType without a key here is a compile
// error (replaces the old assertNever default-case guarantee).
const locationIcons = {
  house: HouseIcon,
  room: HouseIcon,
  area: SquaresFourIcon,
  bag: ShoppingBagIcon,
  shelf: StackIcon,
  table: TableIcon,
  drawer: FileArchiveIcon,
  cart: ShoppingCartIcon,
  cabinet: CubeIcon,
  box: CubeIcon,
  bed: PlantIcon,
  planter: FlowerIcon,
  furniture: PackageIcon,
} satisfies Record<LocationType, Icon>;

/**
 * Get the icon component for a location type
 */
export const getLocationIcon = (type: LocationType | null): Icon =>
  // safe: complete Record keyed by the enum. `furniture` is an instance of a
  // Product; callers holding that Product should prefer `getLocationGlyph`,
  // which resolves the SKU's category icon instead. Null is a type-less hint
  // (a search hit that carries no type).
  type ? locationIcons[type] : PackageIcon;

/**
 * The glyph for a location, resolving identity before form factor.
 *
 * A `furniture` location has no form factor of its own, so its shape comes from the SKU. The
 * product's *category* icon is the right fallback rather than a new column:
 * nine of the sixteen location types already render the same `Box`, so a
 * per-type glyph was never carrying much, while `storage` / `tools` /
 * `household` distinguish the cases that matter.
 */
export const getLocationGlyph = (location: {
  type: LocationType | null;
  product?: { category: ProductCategory | null } | null;
}): Icon => {
  if (location.type && location.type !== "furniture")
    return locationIcons[location.type];
  const category = location.product?.category;
  return category ? getCategoryIcon(category.feature) : PackageIcon;
};
