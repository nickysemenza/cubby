import type { Entity } from "@cubby/schemas/entity";
import type { FC } from "react";
import { PageHero } from "~/components/layouts/page-hero";
import { ImageGallery } from "~/components/media/image-gallery";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { entities } from "~/entities/entities";
import { useDebug } from "~/hooks/useDebug";
import { useIsMobile } from "~/hooks/useMobile";
import { cn } from "~/lib/utils";
import { EntityHero } from "../EntityHero";
import JsonRenderer from "../json-renderer";

export interface DetailSection {
  title: string;
  content: React.ReactNode;
  icon: React.ElementType;
}

interface DetailPageProps {
  sections: DetailSection[];
  entity: Entity;
  name: string;
  rawData: unknown; // The full entity data for debug display
  /** Images shown as a swipeable hero gallery on mobile */
  heroImages?: Array<{ id: string; url: string; filename: string }>;
}

export const DetailPage: FC<DetailPageProps> = ({
  sections,
  entity,
  name,
  rawData,
  heroImages,
}) => {
  const entityDetails = entities[entity];
  const { isDebugEnabled } = useDebug();
  const isMobile = useIsMobile();

  return (
    <div className="space-y-3 sm:space-y-6">
      {/* Hero image gallery — mobile only */}
      {isMobile && heroImages && heroImages.length > 0 && (
        <div className="-mx-4 -mt-4">
          <ImageGallery images={heroImages} />
        </div>
      )}

      <div className="hidden sm:block">
        <PageHero
          variant="detail"
          entity={entity}
          eyebrow={entityDetails.label}
          title={name}
        />
      </div>

      {/* Grid sections */}
      <div className="grid gap-3 sm:gap-6 md:grid-cols-2">
        {/* Image card — desktop only, first in grid */}
        {!isMobile && heroImages && heroImages.length > 0 && (
          <div
            className="fade-in slide-in-from-bottom-2 animate-in"
            style={{ animationFillMode: "both" }}
          >
            <EntityHero images={heroImages} />
          </div>
        )}
        {sections.map((section, index) => (
          <Card
            key={section.title}
            className={cn(
              "transition-all duration-200 ease-cozy",
              "md:hover:-translate-y-0.5 md:hover:shadow-md",
              "fade-in slide-in-from-bottom-2 animate-in",
            )}
            style={{
              animationDelay: `${index * 75}ms`,
              animationFillMode: "both",
            }}
          >
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <section.icon className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">{section.title}</CardTitle>
              </div>
            </CardHeader>
            <CardContent>{section.content}</CardContent>
          </Card>
        ))}
      </div>

      {/* Debug raw details section - full width */}
      {isDebugEnabled && (
        <Card className="fade-in slide-in-from-bottom-2 animate-in duration-300">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Raw Details</CardTitle>
          </CardHeader>
          <CardContent>
            <JsonRenderer input={rawData} pretty />
          </CardContent>
        </Card>
      )}
    </div>
  );
};
