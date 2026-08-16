import type { LocationType } from "@cubby/schemas/location";
import { ImageWithPreview } from "~/components/ui/image-with-preview";
import { LocationIcon } from "./location-icons";

/**
 * The option row's full outer height: its `py-2` twice, plus the name line and
 * the breadcrumb line. Doubles as the Cloudflare transform width.
 */
const THUMB_PX = 52;

/**
 * Square at THUMB_PX, but growing with the row. `minHeight` is what holds the
 * baseline for a top-level location, whose row has no breadcrumb line and would
 * otherwise render a shorter tile than its neighbours.
 */
const BOX = { width: THUMB_PX, minHeight: THUMB_PX };

interface LocationPickerThumbProps {
  imageUrl?: string | null;
  type: LocationType;
}

/**
 * Leading slot for a location dropdown row: the cover photo when there is one,
 * the type icon on a tile when there isn't.
 *
 * Both branches occupy the same box so a roster that mixes photographed and
 * un-photographed locations keeps one baseline — a bare icon beside a photo
 * makes the list ragged and shifts it as results stream in.
 *
 * The tile is full-bleed: the row cancels its own vertical padding on this slot
 * (see `entity-picker`), so the image meets the row's top and bottom edges.
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
      <span
        style={BOX}
        className="flex shrink-0 items-center justify-center self-stretch bg-muted/30"
      >
        {icon}
      </span>
    );
  }

  return (
    <span style={BOX} className="block shrink-0 self-stretch">
      <ImageWithPreview
        src={imageUrl}
        alt=""
        displayWidth={THUMB_PX}
        previewSize={280}
        // Left: the tile is at the row's left edge, so the preview lands
        // outside the popup instead of covering the options you're scanning.
        previewSide="left"
        lazyPreview
        fallback={icon}
        // The default `hover:scale-105` reads as jitter on a tile that already
        // fills its row; z-[300] clears the combobox popup's own z-[200].
        className="size-full rounded-none border-0 transition-none hover:scale-100"
        previewPositionerClassName="z-[300]"
      />
    </span>
  );
}
