import { cn } from "~/lib/utils";
import { Image } from "~/ui/primitives/image";

import type { ComboboxItem } from "./combobox-types";

/**
 * The leading visual for a chosen value — the closed field and selection
 * chips. A record shows its `thumb` (photo, else its fallback glyph) in a
 * fixed box; an option shows its (already tinted) `icon`, or its `color`
 * swatch. Decorative: the field's text carries the name.
 */
export function PickerVisual({
  item,
  size = 20,
}: {
  item: Pick<ComboboxItem, "thumb" | "icon" | "color">;
  size?: 16 | 20 | 24;
}) {
  const { thumb } = item;
  if (thumb) {
    return (
      <span
        aria-hidden
        data-picker-visual=""
        style={{ width: size, height: size }}
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden",
          thumb.shape === "round" ? "rounded-full" : "rounded-[3px]",
        )}
      >
        {thumb.imageUrl ? (
          <Image
            src={thumb.imageUrl}
            alt=""
            displayWidth={size}
            fallback={thumb.fallback}
            className="size-full object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
          />
        ) : (
          thumb.fallback
        )}
      </span>
    );
  }
  if (item.icon) {
    return (
      <span
        aria-hidden
        data-picker-visual=""
        className="flex shrink-0 items-center [&>svg]:size-3.5!"
      >
        {item.icon}
      </span>
    );
  }
  if (item.color) {
    return (
      <span
        aria-hidden
        data-picker-visual=""
        data-enum-option-swatch=""
        className="size-2 shrink-0"
        style={{ backgroundColor: item.color }}
      />
    );
  }
  return null;
}
