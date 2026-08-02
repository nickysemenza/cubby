import { relatedViewRegistry } from "@cubby/schemas/related-view";
import type { FC, ReactNode } from "react";
import { usePageDetailContext } from "~/components/page/Page";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { useDebug } from "~/hooks/useDebug";
import { useIsMobile } from "~/hooks/useMobile";
import { cn } from "~/lib/utils";
import { EntityHero } from "../EntityHero";
import JsonRenderer from "../json-renderer";
import { RelationshipExplorer } from "../relationships/relationship-explorer";
import { relationshipsSectionIcon } from "../relationships/relationship-tree";

type DetailZone = "main" | "aside" | "full";

export interface DetailSection {
  title: string;
  content: React.ReactNode;
  icon: React.ElementType;
  /**
   * Desktop placement. "main" = wide primary column (~2/3) for the entity's
   * actual content; "aside" = narrow metadata rail (~1/3); "full" = full-width
   * band that breaks the column run. Defaults to "aside" — metadata is the
   * common case (all useEntityDetail commonSections are metadata), so pages
   * must explicitly promote their primary content to "main".
   */
  zone?: DetailZone;
  /** Right-aligned header slot: a toolbar, action cluster, or rolled-up stat. */
  headerAction?: ReactNode;
  /** Let inline popovers/comboboxes escape the ruled section card. */
  overflowVisible?: boolean;
}

const zoneOf = (section: DetailSection): DetailZone => section.zone ?? "aside";

/** A single section card. `index` only drives the staggered entrance animation. */
function SectionCard({
  section,
  index,
  size = "default",
}: {
  section: DetailSection;
  index: number;
  size?: "default" | "sm";
}) {
  return (
    <Card
      size={size}
      className={cn(
        "fade-in slide-in-from-bottom-2 animate-in",
        section.overflowVisible && "overflow-visible",
      )}
      style={{
        animationDelay: `${index * 75}ms`,
        animationFillMode: "both",
      }}
    >
      <CardHeader className="pb-2">
        <CardTitle>
          <section.icon className="size-3.5 shrink-0 text-slate" />
          {section.title}
        </CardTitle>
        {section.headerAction && (
          <CardAction>{section.headerAction}</CardAction>
        )}
      </CardHeader>
      <CardContent>{section.content}</CardContent>
    </Card>
  );
}

const STACK_CLASS = "min-w-0 space-y-2 sm:space-y-4";

/** The hero image pseudo-card that rides in the aside rail on desktop. */
function heroCard(
  heroImages: Array<{ id: string; url: string; filename: string }>,
) {
  return (
    <div
      key="entity-hero"
      className="fade-in slide-in-from-bottom-2 animate-in"
      style={{ animationFillMode: "both" }}
    >
      <EntityHero images={heroImages} />
    </div>
  );
}

/**
 * Legacy layout for pages that declare no "main" section: half-width sections
 * dealt round-robin into two equal content-height column stacks, full-width
 * sections spanning both and breaking the run. Byte-compatible with the
 * pre-zones renderer so unmigrated pages don't shift.
 */
function renderLegacyLayout({
  sections,
  heroImages,
}: {
  sections: DetailSection[];
  heroImages?: Array<{ id: string; url: string; filename: string }>;
}): ReactNode {
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
        <div className={STACK_CLASS}>{col1}</div>
        <div className={STACK_CLASS}>{col2}</div>
      </div>,
    );
  };

  sections.forEach((section, i) => {
    if (zoneOf(section) === "full") {
      flushRun();
      blocks.push(
        <SectionCard key={section.title} section={section} index={i} />,
      );
    } else {
      run.push(<SectionCard key={section.title} section={section} index={i} />);
    }
    // Hero image rides at the top of column 2, right after the first section.
    if (i === 0 && heroImages && heroImages.length > 0) {
      run.push(heroCard(heroImages));
    }
  });
  flushRun();

  return <div className="space-y-2 sm:space-y-4">{blocks}</div>;
}

/**
 * Zoned layout: "main" sections stack in a wide primary column (2fr at lg),
 * "aside" sections in a narrow metadata rail (1fr), "full" sections span both
 * and break the run. Each track is its own content-height stack, so a short
 * card never stretches to a tall neighbour. Runs share one track template so
 * the main/aside rule aligns down the page. A run containing only aside
 * sections (e.g. metadata below a full-width contents band) is dealt
 * round-robin into equal columns instead of a lonely 1/3 rail.
 * The md band (768–1023) keeps equal columns; 2fr/1fr asserts at lg.
 */
function renderZonedLayout({
  sections,
  heroImages,
}: {
  sections: DetailSection[];
  heroImages?: Array<{ id: string; url: string; filename: string }>;
}): ReactNode {
  const blocks: ReactNode[] = [];
  let heroPlaced = !heroImages || heroImages.length === 0;
  let run: { main: ReactNode[]; aside: ReactNode[] } = { main: [], aside: [] };

  const flushRun = () => {
    if (run.main.length === 0 && run.aside.length === 0) return;
    const { main, aside } = run;
    run = { main: [], aside: [] };
    if (!heroPlaced && heroImages) {
      aside.unshift(heroCard(heroImages));
      heroPlaced = true;
    }
    if (main.length === 0) {
      // Aside-only run: equal-column deal, three-up at lg where the rail
      // width would otherwise waste 2/3 of the page.
      const cols: ReactNode[][] = [[], [], []];
      aside.forEach((node, i) => {
        cols[i % 3]?.push(node);
      });
      blocks.push(
        <div
          key={`run-${blocks.length}`}
          className="grid grid-cols-2 items-start gap-2 sm:gap-4 lg:grid-cols-3"
        >
          {cols.map((col, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed column slots
            <div key={i} className={STACK_CLASS}>
              {col}
            </div>
          ))}
        </div>,
      );
      return;
    }
    blocks.push(
      <div
        key={`run-${blocks.length}`}
        className="grid grid-cols-2 items-start gap-2 sm:gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
      >
        <div className={STACK_CLASS}>{main}</div>
        <div className={STACK_CLASS}>{aside}</div>
      </div>,
    );
  };

  sections.forEach((section, i) => {
    const zone = zoneOf(section);
    if (zone === "full") {
      flushRun();
      blocks.push(
        <SectionCard key={section.title} section={section} index={i} />,
      );
    } else {
      run[zone].push(
        <SectionCard
          key={section.title}
          section={section}
          index={i}
          size={zone === "aside" ? "sm" : "default"}
        />,
      );
    }
  });
  flushRun();

  // Degenerate case: every section was full-width, so no run ever hosted the
  // hero — give it its own block after the bands.
  if (!heroPlaced && heroImages) {
    blocks.push(
      <div
        key="hero-run"
        className="grid grid-cols-2 items-start gap-2 sm:gap-4 lg:grid-cols-3"
      >
        <div className={STACK_CLASS}>{heroCard(heroImages)}</div>
      </div>,
    );
  }

  return <div className="space-y-2 sm:space-y-4">{blocks}</div>;
}

/**
 * Lay out the section cards. Mobile is a single source-order stack — the
 * section array order is the author-controlled narrative and stays the mobile
 * order regardless of zones. Desktop uses the zoned layout when any section
 * declares an explicit `zone` (a page can be all full+aside, e.g. location's
 * Contents band over a metadata row); pages that never mention zones keep the
 * legacy equal-column round-robin exactly.
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
  const zoned = sections.some((s) => s.zone !== undefined);

  if (isMobile) {
    return (
      <div className="space-y-2 sm:space-y-4">
        {sections.map((section, i) => (
          <SectionCard
            key={section.title}
            section={section}
            index={i}
            size={zoned && zoneOf(section) === "aside" ? "sm" : "default"}
          />
        ))}
      </div>
    );
  }

  return zoned
    ? renderZonedLayout({ sections, heroImages })
    : renderLegacyLayout({ sections, heroImages });
}

interface DetailSectionsProps {
  sections: DetailSection[];
  /** The full entity data for the debug "Raw Details" section. */
  rawData: unknown;
  /** Images — on desktop the first rides at the top of the aside rail. */
  heroImages?: Array<{ id: string; url: string; filename: string }>;
}

/**
 * The headerless detail-page BODY: the section-card grid (with the desktop
 * EntityHero in the aside rail) plus the debug "Raw Details" card. The
 * spec-plate hero is owned by {@link PageHeader} / Page now — wrap this in
 * `<Page variant="detail">`.
 */
export const DetailSections: FC<DetailSectionsProps> = ({
  sections,
  rawData,
  heroImages,
}) => {
  const { isDebugEnabled } = useDebug();
  const isMobile = useIsMobile();
  const pageDetail = usePageDetailContext();
  const sourceId =
    pageDetail?.rawData &&
    typeof pageDetail.rawData === "object" &&
    "id" in pageDetail.rawData &&
    typeof pageDetail.rawData.id === "string"
      ? pageDetail.rawData.id
      : undefined;
  // The explorer intentionally returns nothing for terminal entities. Skip
  // the surrounding section too, so their detail pages do not gain an empty
  // card merely because they have an id.
  const hasSourceViews = relatedViewRegistry.some(
    (view) => view.source === pageDetail?.entity,
  );
  const relationshipSection: DetailSection | undefined =
    pageDetail && sourceId && hasSourceViews
      ? {
          title: "Relationships",
          icon: relationshipsSectionIcon,
          zone: "full",
          content: (
            <RelationshipExplorer
              entity={pageDetail.entity}
              sourceId={sourceId}
            />
          ),
        }
      : undefined;
  const allSections = relationshipSection
    ? [...sections, relationshipSection]
    : sections;

  return (
    <div className="space-y-2 sm:space-y-4">
      {renderSectionLayout({ sections: allSections, isMobile, heroImages })}

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
