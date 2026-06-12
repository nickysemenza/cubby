import type { Entity } from "@cubby/schemas/entity";
import type { FC, ReactNode } from "react";
import { ImageGallery } from "~/components/media/image-gallery";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { InkStamp } from "~/components/ui/ink-stamp";
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

export interface DetailHeroStat {
  label: string;
  value: ReactNode;
}

interface DetailPageProps {
  sections: DetailSection[];
  entity: Entity;
  name: string;
  rawData: unknown; // The full entity data for debug display
  /** Images shown as a swipeable hero gallery on mobile */
  heroImages?: Array<{ id: string; url: string; filename: string }>;
  /** Inline ledger stats on the spec-plate hero (on hand, value, ...) */
  heroStats?: DetailHeroStat[];
  /** Status stamp on the plate (e.g. IN STOCK) */
  heroStamp?: { label: string; tone?: "ink" | "red" | "green" };
  /** Reference code shown in the eyebrow (e.g. the product shortcode) */
  heroNo?: string;
}

/** Pull a created-at date out of the raw entity for the hero's ledger meta. */
function getOnFileSince(rawData: unknown): string | null {
  if (typeof rawData !== "object" || rawData === null) return null;
  const createdAt = (rawData as { createdAt?: unknown }).createdAt;
  if (typeof createdAt !== "string" && !(createdAt instanceof Date)) {
    return null;
  }
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export const DetailPage: FC<DetailPageProps> = ({
  sections,
  entity,
  name,
  rawData,
  heroImages,
  heroStats,
  heroStamp,
  heroNo,
}) => {
  const { isDebugEnabled } = useDebug();
  const isMobile = useIsMobile();
  const onFileSince = getOnFileSince(rawData);
  const entityDef = entities[entity];
  // Entity-colored spine, same runtime class trick as the homepage stat cards.
  const spineClass = entityDef.color.text.replace("text-", "border-l-");

  return (
    <div className="space-y-2 sm:space-y-3">
      {/* Hero image gallery — mobile only */}
      {isMobile && heroImages && heroImages.length > 0 && (
        <div className="-mx-4 -mt-4">
          <ImageGallery images={heroImages} />
        </div>
      )}

      {/* Spec-plate hero: a chunky placard with entity spine, reference no.,
          status stamp, and an inline ledger stat strip. */}
      <Card
        className={cn("border-l-[6px]", spineClass)}
        data-testid="detail-spec-plate"
      >
        <CardContent className="px-4 py-1 sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-2xs text-eyebrow uppercase tracking-[0.14em]">
                {entityDef.pluralLabel}
                {heroNo ? ` / No. ${heroNo}` : ""}
              </p>
              <h1 className="break-words font-bold font-heading text-2xl tracking-tight sm:text-3xl">
                {name}
              </h1>
              {onFileSince && (
                <p className="mt-1 font-mono text-2xs text-muted-foreground uppercase">
                  On file since {onFileSince}
                </p>
              )}
            </div>
            {heroStamp && (
              <InkStamp tone={heroStamp.tone} className="mt-1 shrink-0">
                {heroStamp.label}
              </InkStamp>
            )}
          </div>
          {heroStats && heroStats.length > 0 && (
            <div className="mt-3 flex border-foreground/25 border-t border-dashed pt-2.5">
              {heroStats.map((stat, i) => (
                <div
                  key={stat.label}
                  className={cn(
                    "min-w-0 flex-1",
                    i > 0 && "border-foreground/25 border-l border-dashed pl-4",
                  )}
                >
                  <div className="font-mono text-2xs text-eyebrow uppercase tracking-wider">
                    {stat.label}
                  </div>
                  <div className="truncate font-mono font-semibold text-base tabular-nums">
                    {stat.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Grid sections */}
      <div className="grid gap-2 sm:gap-3 md:grid-cols-2">
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
              "md:hover:-translate-y-0.5 md:hover:shadow-[var(--shadow-chunky-sm)]",
              "fade-in slide-in-from-bottom-2 animate-in",
            )}
            style={{
              animationDelay: `${index * 75}ms`,
              animationFillMode: "both",
            }}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <section.icon className="h-3.5 w-3.5 text-eyebrow" />
                <CardTitle>{section.title}</CardTitle>
              </div>
            </CardHeader>
            <CardContent>{section.content}</CardContent>
          </Card>
        ))}
      </div>

      {/* Debug raw details section - full width */}
      {isDebugEnabled && (
        <Card className="fade-in slide-in-from-bottom-2 animate-in duration-300">
          <CardHeader className="pb-2">
            <CardTitle>Raw Details</CardTitle>
          </CardHeader>
          <CardContent>
            <JsonRenderer input={rawData} pretty />
          </CardContent>
        </Card>
      )}
    </div>
  );
};
