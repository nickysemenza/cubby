import type { AuditEntityType } from "@cubby/schemas/audit";
import type { Entity } from "@cubby/schemas/entity";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { relatedViewRegistry } from "@cubby/schemas/related-view";
import { Clock } from "lucide-react";
import { type FC, type ReactNode, useEffect, useMemo, useState } from "react";
import { usePageDetailContext } from "~/components/page/Page";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { useDebug } from "~/hooks/useDebug";
import { cn } from "~/lib/utils";
import { AuditLogList } from "../audit-log/audit-log-list";
import { EntityHero } from "../EntityHero";
import JsonRenderer from "../json-renderer";
import { RelationshipExplorer } from "../relationships/relationship-explorer";
import { relationshipsSectionIcon } from "../relationships/relationship-tree";

/** Stable id every auto-appended Activity section uses — also the opt-out key: a
 * caller that already supplies a section with this id (e.g. a page composing its
 * own custom activity placement) keeps its own instead of getting a second one. */
const ACTIVITY_SECTION_ID = "history";

const isAuditableEntity = (entity: Entity): entity is AuditEntityType =>
  entityManifest[entity].auditable;

type DetailPlacement = "primary" | "supporting" | "full";

export interface DetailSection {
  /** Stable DOM id and section-index target. */
  id: string;
  title: string;
  content: React.ReactNode;
  icon: React.ElementType;
  /** Explicit narrative role; there is deliberately no automatic default. */
  placement: DetailPlacement;
  /** Exclude low-value/debug regions from the jump index. */
  includeInIndex?: boolean;
  /** Right-aligned header slot: a toolbar, action cluster, or rolled-up stat. */
  headerAction?: ReactNode;
  /** Let inline popovers/comboboxes escape the ruled section card. */
  overflowVisible?: boolean;
  /** Specialized workflows can supply their own internal surface while retaining
   * the shared index, relationship, activity, and debug extensions. */
  surface?: "card" | "plain";
}

function SectionCard({
  section,
  className,
}: {
  section: DetailSection;
  className?: string;
}) {
  if (section.surface === "plain") {
    return (
      <section
        id={section.id}
        tabIndex={-1}
        className={cn(
          "scroll-mt-[calc(var(--app-chrome-top)+3rem)] focus:outline-none",
          className,
        )}
      >
        {section.content}
      </section>
    );
  }

  return (
    <section
      id={section.id}
      tabIndex={-1}
      className={cn(
        "scroll-mt-[calc(var(--app-chrome-top)+3rem)] focus:outline-none",
        className,
      )}
    >
      <Card
        size={section.placement === "supporting" ? "sm" : "default"}
        className={cn(
          "max-md:gap-1 max-md:border-0 max-md:bg-transparent max-md:py-1",
          section.overflowVisible && "overflow-visible",
        )}
      >
        <CardHeader className="px-2 pb-1 md:px-4 md:pb-2">
          <CardTitle as="h2">
            <section.icon className="size-3.5 shrink-0 text-slate" />
            {section.title}
          </CardTitle>
          {section.headerAction && (
            <CardAction>{section.headerAction}</CardAction>
          )}
        </CardHeader>
        <CardContent className="px-2 md:px-4">{section.content}</CardContent>
      </Card>
    </section>
  );
}

const STACK_CLASS = "min-w-0 space-y-2 sm:space-y-4";

function heroVisual({
  heroImages,
  heroMedia,
}: {
  heroImages?: Array<{ id: string; url: string; filename: string }>;
  heroMedia?: ReactNode;
}): ReactNode | undefined {
  if (heroMedia !== undefined) return <div>{heroMedia}</div>;
  return heroImages && heroImages.length > 0 ? (
    <div>
      <EntityHero images={heroImages} />
    </div>
  ) : undefined;
}

export function DetailAnchorIndex({
  sections,
}: {
  sections: Array<Pick<DetailSection, "id" | "title" | "includeInIndex">>;
}) {
  const indexed = useMemo(
    () => sections.filter((section) => section.includeInIndex !== false),
    [sections],
  );
  const indexedIds = useMemo(
    () => indexed.map((section) => section.id),
    [indexed],
  );
  const [activeId, setActiveId] = useState(indexedIds[0]);

  useEffect(() => {
    if (indexedIds.length < 2 || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (a, b) =>
              Math.abs(a.boundingClientRect.top) -
              Math.abs(b.boundingClientRect.top),
          )[0];
        if (visible?.target.id) setActiveId(visible.target.id);
      },
      { rootMargin: "-96px 0px -65% 0px", threshold: [0, 0.01, 0.5] },
    );
    for (const id of indexedIds) {
      const target = document.getElementById(id);
      if (target) observer.observe(target);
    }
    return () => observer.disconnect();
  }, [indexedIds]);

  if (indexed.length < 2) return null;

  const jump = (id: string) => {
    const target = document.getElementById(id);
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    target?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
    target?.focus({ preventScroll: true });
    setActiveId(id);
  };

  return (
    <nav
      aria-label="Record sections"
      className="sticky top-[var(--app-chrome-top)] z-30 flex min-h-11 items-stretch overflow-x-auto overscroll-x-contain border-border border-b bg-card px-1 [scrollbar-width:none] md:min-h-9 md:items-center md:gap-1 md:px-2 [&::-webkit-scrollbar]:hidden"
    >
      <span className="hidden shrink-0 pr-2 font-medium text-muted-foreground text-xs md:block">
        Sections
      </span>
      {indexed.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          aria-current={activeId === section.id ? "location" : undefined}
          onClick={(event) => {
            event.preventDefault();
            window.history.replaceState(null, "", `#${section.id}`);
            jump(section.id);
          }}
          className={cn(
            "relative flex min-h-11 shrink-0 items-center px-2 font-medium text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:min-h-0 md:py-1",
            activeId === section.id
              ? "text-primary after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {section.title}
        </a>
      ))}
    </nav>
  );
}

function renderResponsiveLayout({
  sections,
  visual,
}: {
  sections: DetailSection[];
  visual?: ReactNode;
}) {
  const blocks: ReactNode[] = [];
  let visualPlaced = !visual;
  let run: DetailSection[] = [];

  const flushRun = () => {
    if (run.length === 0 && visualPlaced) return;
    const current = run;
    run = [];
    const primary = current.filter(
      (section) => section.placement === "primary",
    );
    const supporting = current.filter(
      (section) => section.placement === "supporting",
    );
    const pendingVisual = !visualPlaced ? visual : undefined;
    const hasSupportingRail = supporting.length > 0 || pendingVisual;

    const renderRunItems = (withDesktopColumns: boolean) => {
      const items: ReactNode[] = [];
      let visualInserted = false;

      for (const section of current) {
        if (
          pendingVisual &&
          !visualInserted &&
          section.placement === "supporting"
        ) {
          items.push(
            <div
              key="detail-visual"
              data-testid="detail-rail-media"
              className={cn(
                "hidden md:block",
                withDesktopColumns && "lg:col-start-2",
              )}
            >
              {pendingVisual}
            </div>,
          );
          visualInserted = true;
          visualPlaced = true;
        }
        items.push(
          <SectionCard
            key={section.id}
            section={section}
            className={
              withDesktopColumns
                ? section.placement === "primary"
                  ? "lg:col-start-1"
                  : "lg:col-start-2"
                : undefined
            }
          />,
        );
      }

      if (pendingVisual && !visualInserted) {
        items.push(
          <div
            key="detail-visual"
            data-testid="detail-rail-media"
            className={cn(
              "hidden md:block",
              withDesktopColumns && "lg:col-start-2 lg:row-start-1",
            )}
          >
            {pendingVisual}
          </div>,
        );
        visualPlaced = true;
      }

      return items;
    };

    if (primary.length > 0 && hasSupportingRail) {
      blocks.push(
        <div
          key={`run-${blocks.length}`}
          className="max-md:contents md:grid md:items-start md:gap-4 lg:grid-flow-row-dense lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]"
        >
          {renderRunItems(true)}
        </div>,
      );
      return;
    }

    if (primary.length > 0) {
      blocks.push(
        <div
          key={`run-${blocks.length}`}
          className={cn(STACK_CLASS, "max-md:contents")}
        >
          {renderRunItems(false)}
        </div>,
      );
      return;
    }

    if (hasSupportingRail) {
      blocks.push(
        <div
          key={`run-${blocks.length}`}
          className="max-md:contents md:grid md:grid-cols-2 md:items-start md:gap-4 lg:grid-cols-3"
        >
          {renderRunItems(false)}
        </div>,
      );
    }
  };

  for (const section of sections) {
    if (section.placement === "full") {
      flushRun();
      blocks.push(<SectionCard key={section.id} section={section} />);
    } else {
      run.push(section);
    }
  }
  flushRun();
  return (
    <div className="space-y-4 max-md:space-y-0 max-md:divide-y max-md:divide-border max-md:border-border max-md:border-y">
      {blocks}
    </div>
  );
}

interface DetailSectionsProps {
  sections: DetailSection[];
  rawData: unknown;
  heroImages?: Array<{ id: string; url: string; filename: string }>;
  heroMedia?: ReactNode;
}

export const DetailSections: FC<DetailSectionsProps> = ({
  sections,
  rawData,
  heroImages,
  heroMedia,
}) => {
  const { isDebugEnabled } = useDebug();
  const pageDetail = usePageDetailContext();
  const sourceId =
    pageDetail?.rawData &&
    typeof pageDetail.rawData === "object" &&
    "id" in pageDetail.rawData &&
    typeof pageDetail.rawData.id === "string"
      ? pageDetail.rawData.id
      : undefined;
  const hasSourceViews = relatedViewRegistry.some(
    (view) => view.source === pageDetail?.entity,
  );
  // A detail page may own a semantically richer relationship composition than
  // the generic explorer. The explicit section wins just as an explicit
  // History section does below; appending both would duplicate the anchor and
  // let the generic graph contradict the page-owned relationship contract.
  const hasOwnRelationshipSection = sections.some(
    (section) => section.id === "relationships",
  );
  const relationshipSection: DetailSection | undefined =
    pageDetail && sourceId && hasSourceViews && !hasOwnRelationshipSection
      ? {
          id: "relationships",
          title: "Relationships",
          icon: relationshipsSectionIcon,
          placement: "full",
          content: (
            <RelationshipExplorer
              entity={pageDetail.entity}
              sourceId={sourceId}
            />
          ),
        }
      : undefined;
  // Every auditable entity gets its audit trail for free — callers used to
  // hand-wire an identical `AuditLogList` card themselves (five detail pages did,
  // byte-for-byte). The id check is the opt-out: a page that already places its
  // own `id: "history"` section (e.g. via `useEntityDetail`'s commonSections, or
  // a custom placement) keeps that one instead of getting a second.
  const hasOwnActivitySection = sections.some(
    (section) => section.id === ACTIVITY_SECTION_ID,
  );
  const activitySection: DetailSection | undefined =
    pageDetail &&
    sourceId &&
    !hasOwnActivitySection &&
    isAuditableEntity(pageDetail.entity)
      ? {
          id: ACTIVITY_SECTION_ID,
          title: "History",
          icon: Clock,
          placement: "supporting",
          content: (
            <AuditLogList
              entityType={pageDetail.entity}
              entityId={sourceId}
              showEntityLink={false}
            />
          ),
        }
      : undefined;
  const allSections = [
    ...sections,
    ...(activitySection ? [activitySection] : []),
    ...(relationshipSection ? [relationshipSection] : []),
  ].filter(
    (section) => section.content !== null && section.content !== undefined,
  );
  const ids = allSections.map((section) => section.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Detail section ids must be unique within a record page");
  }

  return (
    <div className="space-y-2 sm:space-y-4">
      <DetailAnchorIndex sections={allSections} />
      <div className="fade-in-0 slide-in-from-bottom-1 animate-in duration-150 motion-reduce:animate-none">
        {renderResponsiveLayout({
          sections: allSections,
          visual: heroVisual({
            heroImages,
            heroMedia: heroMedia ?? pageDetail?.heroMedia,
          }),
        })}
      </div>

      {isDebugEnabled && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle as="h2">Raw Details</CardTitle>
          </CardHeader>
          <CardContent>
            <JsonRenderer input={rawData} pretty />
          </CardContent>
        </Card>
      )}
    </div>
  );
};
