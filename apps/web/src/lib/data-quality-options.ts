import { dataQualityStatus } from "@cubby/schemas/data-quality";

import type { BadgeVariant } from "~/ui/primitives/badge";
import { badgeVariantColor } from "~/ui/primitives/badge";
import type { FilterableComboboxItem } from "~/ui/primitives/combobox";

type DataQualityStatus = (typeof dataQualityStatus.options)[number];

const DATA_QUALITY_LABELS = {
  complete: "Complete",
  complete_with_exceptions: "Complete with exceptions",
  needs_data: "Needs data",
  defect: "Defect",
  not_assessed: "Not assessed",
} satisfies Record<DataQualityStatus, string>;

const DATA_QUALITY_TONE = {
  complete: "outline",
  complete_with_exceptions: "plum",
  needs_data: "warning",
  defect: "destructive",
  not_assessed: "outline",
} satisfies Record<DataQualityStatus, BadgeVariant>;

/** The status label a quality value shows beside (or, when unscored, instead of) its score. */
export const dataQualityStatusLabel = (status: DataQualityStatus): string =>
  DATA_QUALITY_LABELS[status];

/** Shared internal status roster and tone. */
export const dataQualityOptions: FilterableComboboxItem[] =
  dataQualityStatus.options.map((value) => ({
    value,
    label: DATA_QUALITY_LABELS[value],
    color: badgeVariantColor[DATA_QUALITY_TONE[value]],
  }));
