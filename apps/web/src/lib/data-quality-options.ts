import { dataQualityStatus } from "@cubby/schemas/data-quality";

import type { BadgeVariant } from "~/components/ui/badge";
import { badgeVariantColor } from "~/components/ui/badge";
import type { FilterableComboboxItem } from "~/components/ui/combobox";

type DataQualityStatus = (typeof dataQualityStatus.options)[number];

const DATA_QUALITY_LABELS: Record<DataQualityStatus, string> = {
  complete: "Complete",
  needs_data: "Needs data",
  defect: "Defect",
};

const DATA_QUALITY_TONE: Record<DataQualityStatus, BadgeVariant> = {
  complete: "outline",
  needs_data: "warning",
  defect: "destructive",
};

/**
 * The one roster for `dataQuality.status` — labels, tone, and filter options.
 *
 * Previously the products table humanized it while the purchases table rendered
 * `info.getValue()`, printing the raw `needs_data` at the operator; and the
 * filter manifest declared the same three labels twice, once per entity. The
 * label a cell shows and the label its filter offers are now the same string by
 * construction. `needs_data` is amber rather than red: it is a worklist item, and
 * only `defect` is a thing that is actually wrong.
 */
export const dataQualityOptions: FilterableComboboxItem[] =
  dataQualityStatus.options.map((value) => ({
    value,
    label: DATA_QUALITY_LABELS[value],
    color: badgeVariantColor[DATA_QUALITY_TONE[value]],
  }));
