import type { InfLocation, LocationUpdateInput } from "@cubby/schemas/location";
import { Eye, Info, Package } from "lucide-react";
import { type FC, useState } from "react";

import { locationGardenSections } from "~/app/garden/garden-seam-sections";
import { Page } from "~/components/page/Page";
import { locationEditRequest } from "~/entities/editing/editor-requests";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";

import { type DetailSection, DetailSections } from "../data-table/detail-page";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { AiDescriptionSection } from "./ai-description-section";
import { LocationBasicInfo } from "./location-basic-info";
import { LocationBreadcrumb } from "./location-breadcrumb";
import {
  LocationContents,
  LocationContentsValuation,
} from "./location-contents";
import { LocationVisual } from "./location-visual";

interface LocationDetailProps {
  record: InfLocation;
}

export const LocationDetail: FC<LocationDetailProps> = ({
  record: location,
}) => {
  const heroMedia = (
    <LocationVisual location={location} variant="hero" interactive />
  );
  const [editOpen, setEditOpen] = useState(false);

  const { commonSections } = useEntityDetail<
    "location",
    InfLocation,
    LocationUpdateInput
  >({
    entity: "location",
    data: location,
  });

  const sections: DetailSection[] = [
    // A bed/tray's Garden section leads the page when present (only when
    // `gardenKind` is set) — see `garden-seam-sections.tsx`. `DetailSections`
    // has no collapsible/`defaultOpen` flag, so the inventory-first sections
    // below are demoted by reordering after Garden rather than collapsing.
    ...locationGardenSections(location),
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
    {
      id: "basic-information",
      title: "Basic Information",
      icon: Info,
      placement: "supporting",
      content: (
        <LocationBasicInfo
          location={location}
          onEdit={() => setEditOpen(true)}
        />
      ),
    },
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
      <EntityEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        request={locationEditRequest(location)}
      />
    </Page>
  );
};
