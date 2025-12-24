import {
  Home,
  ShoppingBag,
  Layers,
  Table2,
  FileBox,
  ShoppingCart,
  Box,
  type LucideIcon,
} from "lucide-react";
import { assertNever } from "~/lib/assert";
import { type LocationType } from "~/schemas/location";

// Helper to get icon for a location type
export const getLocationIcon = (type: LocationType): LucideIcon => {
  switch (type) {
    case "room":
      return Home;
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

// Keep LocationIcon for backward compatibility
interface LocationIconProps {
  type: LocationType;
  className?: string;
  size?: number;
}

export function LocationIcon({
  type,
  className,
  size = 16,
}: LocationIconProps) {
  /* eslint-disable react-hooks/static-components */
  const IconComponent = getLocationIcon(type);
  return <IconComponent className={className} size={size} />;
  /* eslint-enable react-hooks/static-components */
}

interface LocationIconWithLabelProps extends LocationIconProps {
  label: string;
  showLabel?: boolean;
}

export function LocationIconWithLabel({
  type,
  label,
  className,
  size = 16,
  showLabel = true,
}: LocationIconWithLabelProps) {
  return (
    <div className="flex items-center gap-2">
      <LocationIcon type={type} className={className} size={size} />
      {showLabel && <span>{label}</span>}
    </div>
  );
}
