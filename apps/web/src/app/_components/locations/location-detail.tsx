import type { InfLocation, LocationUpdateInput } from "@cubby/schemas/location";
import { Eye, Info, Package } from "lucide-react";
import type { FC } from "react";

import { Page } from "~/components/page/Page";

import { type DetailSection, DetailSections } from "../data-table/detail-page";
import { editableDetailSection } from "../data-table/editable-detail-section";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { AiDescriptionSection } from "./ai-description-section";
import { LocationBasicInfo } from "./location-basic-info";
import { LocationBreadcrumb } from "./location-breadcrumb";
import {
  LocationContents,
  LocationContentsValuation,
} from "./location-contents";
import { LocationForm } from "./location-form";
import { LocationVisual } from "./location-visual";

interface LocationDetailProps {
  location: InfLocation;
}

export const LocationDetail: FC<LocationDetailProps> = ({ location }) => {
  const heroMedia = (
    <LocationVisual location={location} variant="hero" interactive />
  );

  const { commonSections, editMode } = useEntityDetail<
    InfLocation,
    LocationUpdateInput
  >({
    entity: "location",
    data: location,
  });

  const sections: DetailSection[] = [
    // The page IS this section: sub-locations + items on one surface, with
    // the valuation rollup in the header. Basic info / AI description /
    // history are the metadata row below.
    {
      id: "contents",
      title: "Contents",
      icon: Package,
      placement: "full",
      headerAction: <LocationContentsValuation location={location} />,
      content: <LocationContents location={location} />,
    },
    editableDetailSection({
      id: "basic-information",
      title: "Basic Information",
      icon: Info,
      placement: "supporting",
      editMode,
      Form: LocationForm,
      entity: location,
      children: (
        <LocationBasicInfo location={location} onEdit={editMode.startEditing} />
      ),
    }),
    {
      id: "ai-description",
      title: "AI Description",
      icon: Eye,
      placement: "supporting",
      content: (
        <AiDescriptionSection
          locationId={location.id}
          currentDescription={location.aiDescription ?? null}
          hasImages={(location.images ?? []).length > 0}
        />
      ),
    },
    // Common sections from entity config (History)
    ...commonSections,
  ];

  return (
    <Page
      variant="detail"
      entity="location"
      title={location.name}
      rawData={location}
      heroImages={location.images}
      heroMedia={heroMedia}
      heroNo={location.id ?? undefined}
    >
      {/* Breadcrumb lives inside Page so it stays within the max-width page
          container rather than becoming a full-width route sibling. */}
      <LocationBreadcrumb
        location={location}
        linkable
        compact
        className="min-h-11 border-y border-border px-2"
      />
      <DetailSections
        sections={sections}
        rawData={location}
        heroImages={location.images}
      />
    </Page>
  );
};
