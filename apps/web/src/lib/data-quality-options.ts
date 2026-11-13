import type { dataQualityStatus } from "@cubby/schemas/data-quality";

type DataQualityStatus = (typeof dataQualityStatus.options)[number];

const DATA_QUALITY_LABELS = {
  complete: "Done",
  complete_with_exceptions: "Done",
  needs_data: "Needs you",
  defect: "Stuck",
  not_assessed: "Waiting",
} satisfies Record<DataQualityStatus, string>;

/** The status label a quality value shows beside (or, when unscored, instead of) its score. */
export const dataQualityStatusLabel = (status: DataQualityStatus): string =>
  DATA_QUALITY_LABELS[status];
