import type { LocationType } from "@cubby/schemas/location";
import { DotLabel } from "~/components/ui/dot-label";
import { getLocationTypeColor } from "./location-type-theme";

interface LocationTypeLabelProps {
  type: LocationType;
}

export function LocationTypeLabel({ type }: LocationTypeLabelProps) {
  return <DotLabel color={getLocationTypeColor(type)}>{type}</DotLabel>;
}
