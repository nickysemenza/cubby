import type { LocationType } from "@cubby/schemas/location";

import { EnumPill } from "~/components/ui/enum-pill";

import { LocationIcon } from "./location-icons";
import { getLocationTypeColor } from "./location-type-theme";

interface LocationTypeLabelProps {
  type: LocationType | null;
  /**
   * The SKU this location IS. When present the location carries no `type` of
   * its own, so the product's name is the label — "PACKOUT 3-Drawer" says
   * strictly more than "box".
   *
   * Required, not optional. Optional is how ~20 call sites silently rendered
   * an empty label for every product-linked location: the compiler had no
   * reason to mention them. Pass `null` explicitly where a location genuinely
   * cannot have one (an enum picker row, a hardcoded placeholder).
   */
  product: { name: string } | null;
}

export function LocationTypeLabel({ type, product }: LocationTypeLabelProps) {
  const text = type ?? product?.name;
  if (!text) return null;
  return (
    <EnumPill
      color={getLocationTypeColor(type)}
      icon={
        type ? <LocationIcon type={type} product={null} size={10} /> : undefined
      }
    >
      {text}
    </EnumPill>
  );
}
