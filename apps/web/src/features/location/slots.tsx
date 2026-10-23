import type { FunctionComponent } from "react";

import type { CollectionActionProps } from "~/entity/entity-detail/collection-actions";
import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { SubjectJobsDisclosure } from "~/features/job/job-diagnostics";
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
    <EntityReportSlot
      slot="location.ai-description"
      id={location.id}
      record={location}
    />
    <SubjectJobsDisclosure subject={{ kind: "location", id: location.id }} />
  </Stack>
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
