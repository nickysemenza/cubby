import { getLocationTypeColor, type LocationType } from "@cubby/shared";
import { Pill } from "./Pill";

interface LocationTypeBadgeProps {
  type: LocationType;
}

export function LocationTypeBadge({ type }: LocationTypeBadgeProps) {
  return (
    <Pill label={type.replace("-", " ")} color={getLocationTypeColor(type)} />
  );
}
