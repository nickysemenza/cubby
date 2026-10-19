import type { dataQualityStatus } from "@cubby/schemas/data-quality";

type DataQualityStatus = (typeof dataQualityStatus.options)[number];

const DATA_QUALITY_LABELS = {
  complete: "Complete",
  complete_with_exceptions: "Complete with exceptions",
  needs_data: "Needs data",
  defect: "Defect",
  not_assessed: "Not assessed",
} satisfies Record<DataQualityStatus, string>;

/** The status label a quality value shows beside (or, when unscored, instead of) its score. */
export const dataQualityStatusLabel = (status: DataQualityStatus): string =>
  DATA_QUALITY_LABELS[status];
