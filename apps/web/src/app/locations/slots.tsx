import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
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

export const LocationAiDescription: DetailSlotComponent<"location"> = ({
  record: location,
}) => (
  <AiDescriptionSection
    locationId={location.id}
    currentDescription={location.aiDescription ?? null}
    hasImages={(location.images ?? []).length > 0}
  />
);
