import type { LocationType } from "@cubby/schemas/location";
import { Image } from "~/components/ui/image";
import { LocationIcon } from "./location-icons";

const THUMB_PX = 24;

interface LocationPickerThumbProps {
  imageUrl?: string | null;
  type: LocationType;
}

/**
 * Leading slot for a location dropdown row: the cover photo when there is one,
 * the type icon on a tile when there isn't.
 *
 * Both branches occupy the same 24px square so a roster that mixes photographed
 * and un-photographed locations keeps one baseline — a bare 14px icon beside a
 * 24px photo makes the list ragged and shifts it as results stream in.
 */
export function LocationPickerThumb({
  imageUrl,
  type,
}: LocationPickerThumbProps) {
  const icon = (
    <LocationIcon type={type} size={14} className="text-muted-foreground" />
  );

  if (!imageUrl) {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center bg-muted/30">
        {icon}
      </span>
    );
  }

  return (
    <Image
      src={imageUrl}
      alt=""
      displayWidth={THUMB_PX}
      fallback={icon}
      className="size-6 shrink-0 border border-[var(--border)] object-cover"
    />
  );
}
