import type { FC, ReactNode } from "react";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useDebug } from "~/hooks/useDebug";
import { useIsMobile } from "~/hooks/useMobile";
import { cn } from "~/lib/utils";
import { EntityHero } from "../EntityHero";
import JsonRenderer from "../json-renderer";

// Re-exported for back-compat — the spec-plate ledger stat type now lives with
// the unified PageHeader. Unmigrated detail pages import it from here.
export type { DetailHeroStat };

export interface DetailSection {
  title: string;
  content: React.ReactNode;
  icon: React.ElementType;
  /** Span both grid columns on desktop — for wide content like multi-column tables. */
  fullWidth?: boolean;
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
          <section.icon className="h-3.5 w-3.5 text-slate" />
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
      <div className="space-y-2 sm:space-y-4">
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
        className="grid grid-cols-2 items-start gap-2 sm:gap-4"
      >
        <div className="space-y-2 sm:space-y-4">{col1}</div>
        <div className="space-y-2 sm:space-y-4">{col2}</div>
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

  return <div className="space-y-2 sm:space-y-4">{blocks}</div>;
}

interface DetailSectionsProps {
  sections: DetailSection[];
  /** The full entity data for the debug "Raw Details" section. */
  rawData: unknown;
  /** Images — on desktop the first rides at the top of section column 2. */
  heroImages?: Array<{ id: string; url: string; filename: string }>;
}

/**
 * The headerless detail-page BODY: the section-card grid (with the desktop
 * EntityHero in column 2) plus the debug "Raw Details" card. The spec-plate hero
 * is owned by {@link PageHeader} / Page now — wrap this in `<Page variant="detail">`.
 */
export const DetailSections: FC<DetailSectionsProps> = ({
  sections,
  rawData,
  heroImages,
}) => {
  const { isDebugEnabled } = useDebug();
  const isMobile = useIsMobile();

  return (
    <div className="space-y-2 sm:space-y-4">
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
