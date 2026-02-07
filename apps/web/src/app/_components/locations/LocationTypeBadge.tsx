import type { LocationType } from "@cubby/schemas/location";
import { Pill } from "~/app/_components/Pill";
import { LocationIcon } from "./location-icons";
import { getLocationTypeColor } from "./location-type-theme";

interface LocationTypeBadgeProps {
  type: LocationType;
}

export function LocationTypeBadge({ type }: LocationTypeBadgeProps) {
  return (
    <Pill
      icon={<LocationIcon type={type} size={12} colored />}
      color={getLocationTypeColor(type)}
    >
      {type}
    </Pill>
  );
}
