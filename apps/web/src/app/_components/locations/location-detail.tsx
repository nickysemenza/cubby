import type { InfLocation, LocationUpdateInput } from "@cubby/schemas/location";
import { Eye, Info, Package } from "lucide-react";
import type { FC } from "react";
import { Page } from "~/components/page/Page";
import { useTRPC } from "~/integrations/trpc/react";
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
  const api = useTRPC();
  const heroMedia = (
    <LocationVisual location={location} variant="hero" interactive />
  );

  const { commonSections, editMode } = useEntityDetail<
    InfLocation,
    LocationUpdateInput
  >({
    entity: "location",
    data: location,
    mutationOptions: api.location.update.mutationOptions(),
  });

  const sections: DetailSection[] = [
    // The page IS this section: sub-locations + items on one surface, with
    // the valuation rollup in the header. Basic info / AI description /
    // history are the metadata row below.
    {
      title: "Contents",
      icon: Package,
      zone: "full",
      headerAction: <LocationContentsValuation location={location} />,
      content: <LocationContents location={location} />,
    },
    editableDetailSection({
      title: "Basic Information",
      icon: Info,
      editMode,
      Form: LocationForm,
      entity: location,
      children: (
        <LocationBasicInfo location={location} onEdit={editMode.startEditing} />
      ),
    }),
    {
      title: "AI Description",
      icon: Eye,
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
      {/* Breadcrumb lives inside Page so it sits within the max-width
          container (was full-width when the route PageWrapper was dropped). */}
      <LocationBreadcrumb location={location} linkable />
      <DetailSections
        sections={sections}
        rawData={location}
        heroImages={location.images}
      />
    </Page>
  );
};
