import type { Entity } from "@cubby/schemas/entity";
import type { FilterOptionItem } from "@cubby/schemas/filter-options";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import { createElement } from "react";

import type { PickerOption } from "~/ui/combobox/picker-option";

import { EntityIdentityMark } from "./components/entity-identity-mark";

/** Preserve identity metadata without starting record reads from option rows. */
export function recordFilterOption(
  entity: Entity,
  item: FilterOptionItem,
  displayImage: ImageUrlSummary | null,
): PickerOption {
  return {
    value: item.id,
    label: item.label,
    detail: item.detail,
    hint: item.count == null ? undefined : String(item.count),
    icon: createElement(EntityIdentityMark, {
      entity,
      id: item.id,
      name: item.label,
      displayImage,
      emoji: item.emoji,
      size: "pill",
    }),
  };
}
