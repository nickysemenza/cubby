import { type LocationType, locationType } from "@cubby/schemas/location";
import { getLocationIcon, getLocationTypeColor } from "./location-type-theme";

interface LocationIconProps {
  type: LocationType;
  className?: string;
  size?: number;
  /** Apply the type-specific color */
  colored?: boolean;
}

export function LocationIcon({
  type,
  className,
  size = 16,
  colored,
}: LocationIconProps) {
  const IconComponent = getLocationIcon(type);
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
  label,
  className,
  size = 16,
  showLabel = true,
  colored,
}: LocationIconWithLabelProps) {
  return (
    <div className="flex items-center gap-2">
      <LocationIcon
        type={type}
        className={className}
        size={size}
        colored={colored}
      />
      {showLabel && <span>{label}</span>}
    </div>
  );
}

/** Location type options with colored icons for dropdowns */
export const locationTypeOptionsWithTheme = locationType.options.map(
  (type) => ({
    value: type,
    label: type,
    icon: <LocationIcon type={type} size={14} colored />,
    color: getLocationTypeColor(type),
  }),
);
