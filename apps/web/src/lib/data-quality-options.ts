import { dataQualityStatus } from "@cubby/schemas/data-quality";

import type { BadgeVariant } from "~/ui/primitives/badge";
import { badgeVariantColor } from "~/ui/primitives/badge";
import type { FilterableComboboxItem } from "~/ui/primitives/combobox";

type DataQualityStatus = (typeof dataQualityStatus.options)[number];

const DATA_QUALITY_LABELS = {
  complete: "Complete",
  needs_data: "Needs data",
  defect: "Defect",
} satisfies Record<DataQualityStatus, string>;

const DATA_QUALITY_TONE = {
  complete: "outline",
  needs_data: "warning",
  defect: "destructive",
} satisfies Record<DataQualityStatus, BadgeVariant>;

/** Shared internal status roster and tone; quality values display only the score. */
export const dataQualityOptions: FilterableComboboxItem[] =
  dataQualityStatus.options.map((value) => ({
    value,
    label: DATA_QUALITY_LABELS[value],
    color: badgeVariantColor[DATA_QUALITY_TONE[value]],
  }));
