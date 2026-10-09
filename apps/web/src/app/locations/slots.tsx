import type { FunctionComponent } from "react";

import type { CollectionActionProps } from "~/entity/entity-detail/detail-hooks";
import type { DetailSlotComponent } from "~/entity/entity-detail/detail-hooks";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { AiDescriptionSection } from "~/features/locations/ai-description-section";

/**
 * Rolled-up total (direct + descendants, from the persisted
 * `location.valuation`) with the by-manufacturer breakdown of the items
 * stored directly here.
 */
export const LocationContentsValuation: DetailSlotComponent<"location"> = ({
  record: location,
}) => <EntityReportSlot slot="location.contents-valuation" id={location.id} />;

/** The saved description, from the server's report; analyzing is `AnalyzeLocationAction`. */
export const LocationAiDescription: DetailSlotComponent<"location"> = ({
  record: location,
}) => (
  <EntityReportSlot
    slot="location.ai-description"
    id={location.id}
    record={location}
  />
);

/** Analyze action of the AI description report: the photo analysis and its proposal review. */
export const AnalyzeLocationAction: FunctionComponent<
  CollectionActionProps<"location">
> = ({ record: location }) => (
  <AiDescriptionSection
    locationId={location.id}
    hasImages={(location.images ?? []).length > 0}
  />
);
