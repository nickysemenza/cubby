import type { Entity } from "@cubby/schemas/entity";
import type { FC, ReactNode } from "react";
import { ImageGallery } from "~/components/media/image-gallery";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Eyebrow } from "~/components/ui/eyebrow";
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
  /** Span both grid columns on desktop — for wide content like multi-column tables. */
  fullWidth?: boolean;
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
  /** Page-level action cluster (edit / move / delete) rendered on the hero plate. */
  actions?: ReactNode;
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

/** A single section card. `index` only drives the staggered entrance animation. */
function SectionCard({
  section,
  index,
}: {
  section: DetailSection;
  index: number;
}) {
  return (
    <Card
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
  );
}

/**
 * Lay out the section cards. Mobile is a single source-order stack. Desktop packs
 * the two columns independently: half-width sections are dealt round-robin into
 * content-height column stacks so a short card never stretches to a tall
 * neighbour's height; full-width sections span both columns and break the run.
 */
function renderSectionLayout({
  sections,
  isMobile,
  heroImages,
}: {
  sections: DetailSection[];
  isMobile: boolean;
  heroImages?: Array<{ id: string; url: string; filename: string }>;
}): ReactNode {
  if (isMobile) {
    return (
      <div className="space-y-2 sm:space-y-3">
        {sections.map((section, i) => (
          <SectionCard key={section.title} section={section} index={i} />
        ))}
      </div>
    );
  }

  const blocks: ReactNode[] = [];
  let run: ReactNode[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    const items = run;
    run = [];
    const col1 = items.filter((_, i) => i % 2 === 0);
    const col2 = items.filter((_, i) => i % 2 === 1);
    blocks.push(
      <div
        key={`run-${blocks.length}`}
        className="grid grid-cols-2 items-start gap-2 sm:gap-3"
      >
        <div className="space-y-2 sm:space-y-3">{col1}</div>
        <div className="space-y-2 sm:space-y-3">{col2}</div>
      </div>,
    );
  };

  sections.forEach((section, i) => {
    if (section.fullWidth) {
      flushRun();
      blocks.push(
        <SectionCard key={section.title} section={section} index={i} />,
      );
    } else {
      run.push(<SectionCard key={section.title} section={section} index={i} />);
    }
    // Hero image rides at the top of column 2, right after the first section.
    if (i === 0 && heroImages && heroImages.length > 0) {
      run.push(
        <div
          key="entity-hero"
          className="fade-in slide-in-from-bottom-2 animate-in"
          style={{ animationFillMode: "both" }}
        >
          <EntityHero images={heroImages} />
        </div>,
      );
    }
  });
  flushRun();

  return <div className="space-y-2 sm:space-y-3">{blocks}</div>;
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
  actions,
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
              <Eyebrow className="tracking-[0.14em]">
                {entityDef.pluralLabel}
                {heroNo ? ` / No. ${heroNo}` : ""}
              </Eyebrow>
              <h1 className="break-words font-bold font-heading text-2xl tracking-tight sm:text-3xl">
                {name}
              </h1>
              {onFileSince && (
                <p className="mt-1 font-mono text-2xs text-muted-foreground uppercase">
                  On file since {onFileSince}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {heroStamp && (
                <InkStamp tone={heroStamp.tone} className="mt-1">
                  {heroStamp.label}
                </InkStamp>
              )}
              {actions}
            </div>
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
                  <Eyebrow as="div">{stat.label}</Eyebrow>
                  <div className="truncate font-mono font-semibold text-base tabular-nums">
                    {stat.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section cards. On desktop the two columns pack INDEPENDENTLY — each is a
          content-height stack, so a short card (e.g. Basic Info) never stretches to
          match a tall neighbour. Half-width sections are dealt out round-robin into
          the two columns; full-width sections span both and break the column run.
          On mobile everything is one source-order stack (the hero gallery already
          shows at the top, so the image pseudo-card is desktop-only). */}
      {renderSectionLayout({ sections, isMobile, heroImages })}

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
