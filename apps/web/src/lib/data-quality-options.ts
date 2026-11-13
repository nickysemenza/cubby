import type { dataQualityStatus } from "@cubby/schemas/data-quality";
import { dataQualityLabel } from "@cubby/schemas/field-envelope-presentation";

type DataQualityStatus = (typeof dataQualityStatus.options)[number];

/** The status label a quality value shows beside (or, when unscored, instead of) its score. */
export const dataQualityStatusLabel = (status: DataQualityStatus): string =>
  dataQualityLabel(status);
