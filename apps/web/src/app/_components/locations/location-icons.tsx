import { type LocationType, locationType } from "@cubby/schemas/location";
import type { ProductCategory } from "@cubby/shared";

import { Row } from "~/components/layout";

import { getLocationGlyph, getLocationTypeColor } from "./location-type-theme";

/**
 * Enough of a location to draw it. `type` is null for a location that IS a
 * Product, in which case the SKU's category supplies the glyph — see
 * `getLocationGlyph`.
 */
interface LocationGlyphSource {
  type: LocationType | null;
  product: { category: ProductCategory | null } | null;
}

interface LocationIconProps extends LocationGlyphSource {
  className?: string;
  size?: number;
  /** Apply the type-specific color */
  colored?: boolean;
}

export function LocationIcon({
  type,
  product,
  className,
  size = 16,
  colored,
}: LocationIconProps) {
  const IconComponent = getLocationGlyph({ type, product });
  return (
    <IconComponent
      className={className}
      size={size}
      style={colored ? { color: getLocationTypeColor(type) } : undefined}
    />
  );
}

interface LocationIconWithLabelProps extends LocationIconProps {
  label: string;
  showLabel?: boolean;
}

export function LocationIconWithLabel({
  type,
  product,
  label,
  className,
  size = 16,
  showLabel = true,
  colored,
}: LocationIconWithLabelProps) {
  return (
    <Row align="center" gap="sm">
      <LocationIcon
        type={type}
        product={product}
        className={className}
        size={size}
        colored={colored}
      />
      {showLabel && <span>{label}</span>}
    </Row>
  );
}

/**
 * Location type options with colored icons for dropdowns. The shared static
 * picker suppresses its fallback swatch when an option already has an icon.
 */
export const locationTypeOptionsWithTheme = locationType.options.map(
  (type) => ({
    value: type,
    label: type,
    icon: <LocationIcon type={type} product={null} size={14} colored />,
  }),
);
