import type { LocationType } from "@cubby/schemas/location";
import { DotLabel } from "~/components/ui/dot-label";
import { getLocationTypeColor } from "./location-type-theme";

interface LocationTypeLabelProps {
  type: LocationType | null;
  /**
   * The SKU this location IS. When present the location carries no `type` of
   * its own, so the product's name is the label — "PACKOUT 3-Drawer" says
   * strictly more than "box".
   */
  product?: { name: string } | null;
}

export function LocationTypeLabel({ type, product }: LocationTypeLabelProps) {
  const text = type ?? product?.name;
  if (!text) return null;
  return <DotLabel color={getLocationTypeColor(type)}>{text}</DotLabel>;
}
