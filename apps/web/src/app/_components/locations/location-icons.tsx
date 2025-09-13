import {
  Home,
  ShoppingBag,
  Layers,
  Package,
  Archive,
  Table2,
  FileBox,
  ShoppingCart,
  Box,
} from "lucide-react";
import { type LocationType } from "~/schemas/location";

const LocationTypeIcons: Record<LocationType, typeof Home> = {
  room: Home,
  bag: ShoppingBag,
  shelf: Layers,
  crate: Package,
  "half-crate": Archive,
  table: Table2,
  drawer: FileBox,
  cart: ShoppingCart,
  cabinet: Box,
};

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
  const IconComponent = LocationTypeIcons[type];
  return <IconComponent className={className} size={size} />;
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
