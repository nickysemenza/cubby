import { fieldValueOf } from "@cubby/schemas/field-envelope";
import type { FunctionComponent } from "react";

import type { CollectionActionProps } from "~/entity/entity-detail/collection-actions";
import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { RecordWorkerFacts } from "~/entity/machinery/record-machinery";
import { AiDescriptionSection } from "~/features/location/ai-description-section";
import { Stack } from "~/ui/layout";

/**
 * Rolled-up total (direct + descendants, from the persisted
 * `location.valuation`) with the by-brandName breakdown of the items
 * stored directly here.
 */
export const LocationContentsValuation: DetailSlotComponent<"location"> = ({
  record: location,
}) => <EntityReportSlot slot="location.contents-valuation" id={location.id} />;

/** The saved description, from the server's report; analyzing is `AnalyzeLocationAction`. */
export const LocationAiDescription: DetailSlotComponent<"location"> = ({
  record: location,
}) => (
  <Stack gap="sm">
    <RecordWorkerFacts entity="location" id={location.id} />
    <EntityReportSlot
      slot="location.ai-description"
      id={location.id}
      record={location}
    />
  </Stack>
);

/** Analyze action of the AI description report: the photo analysis and its proposal review. */
export const AnalyzeLocationAction: FunctionComponent<
  CollectionActionProps<"location">
> = ({ record: location }) => {
  const effectiveLocationImages = fieldValueOf(location.fields.images);
  return (
    <AiDescriptionSection
      locationId={location.id}
      hasImages={(effectiveLocationImages ?? []).length > 0}
    />
  );
};
