import type { LocationType } from "@cubby/schemas/location";
import { DotLabel } from "~/app/_components/DotLabel";
import { getLocationTypeColor } from "./location-type-theme";

interface LocationTypeBadgeProps {
  type: LocationType;
}

export function LocationTypeBadge({ type }: LocationTypeBadgeProps) {
  return <DotLabel color={getLocationTypeColor(type)}>{type}</DotLabel>;
}
