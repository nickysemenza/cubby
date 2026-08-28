import type { ImageStatus } from "@cubby/schemas/image";
import { imageStatusValues } from "@cubby/schemas/image";

import { type BadgeVariant, badgeVariantColor } from "~/components/ui/badge";
import type { FilterableComboboxItem } from "~/components/ui/combobox";

const IMAGE_STATUS_LABELS = {
  PENDING: "Pending",
  UPLOADED: "Uploaded",
  FAILED: "Failed",
} satisfies Record<ImageStatus, string>;

const IMAGE_STATUS_TONE = {
  PENDING: "slate",
  UPLOADED: "positive",
  FAILED: "destructive",
} satisfies Record<ImageStatus, BadgeVariant>;

/**
 * Labels and tone for `Image.status`.
 *
 * The old badge printed the raw enum as its own label, so the column read
 * `UPLOADED` / `PENDING` in shouting snake-case — the DB's vocabulary leaking
 * into the UI. `UPLOADED` is also the healthy terminal state, and it was tinted
 * amber; only `FAILED` is a problem.
 */
export const imageStatusOptions: FilterableComboboxItem[] =
  imageStatusValues.map((value) => ({
    value,
    label: IMAGE_STATUS_LABELS[value],
    color: badgeVariantColor[IMAGE_STATUS_TONE[value]],
  }));
