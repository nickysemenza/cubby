import type { Entity } from "@cubby/schemas/entity";
import { isAuditableEntity } from "@cubby/schemas/entity-manifest";
import { relatedViewRegistry } from "@cubby/schemas/related-view";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { Clock } from "lucide-react";
import {
  type FC,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { z } from "zod";

import { Row } from "~/components/layout";
import { usePageDetailContext } from "~/components/page/Page";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useDebug } from "~/hooks/useDebug";
import { cn } from "~/lib/utils";

import {
  EntityActionButtons,
  type EntityActionRow,
} from "../actions/entity-actions";
import { AuditLogList } from "../audit-log/audit-log-list";
import { EntityHero } from "../EntityHero";
import JsonRenderer from "../json-renderer";
import { RelationshipExplorer } from "../relationships/relationship-explorer";
import {
  RelationshipRoutePreview,
  relationshipRouteSourceFromRecord,
} from "../relationships/relationship-route-preview";
import { relationshipsSectionIcon } from "../relationships/relationship-tree";

/** Stable id every auto-appended Activity section uses — also the opt-out key: a
 * caller that already supplies a section with this id (e.g. a page composing its
 * own custom activity placement) keeps its own instead of getting a second one. */
const ACTIVITY_SECTION_ID = "history";
const RELATIONS_SECTION_ID = "relationships";

type DetailMode = "overview" | "relations" | "activity";
type DetailHashResolution = { mode: DetailMode; valid: boolean };

const detailRecordSchema = z
  .object({
    id: z.string().optional(),
    fdc_id: z.number().optional(),
    name: z.string().optional(),
    date: z.string().optional(),
    description: z.string().optional(),
    filename: z.string().optional(),
  })
  .passthrough();
type DetailRecord = z.output<typeof detailRecordSchema>;

function normalizedHash(hash: string) {
  return hash.startsWith("#") ? hash.slice(1) : hash;
}

function detailSourceId(
  entity: Entity,
  record: DetailRecord | undefined,
): string | undefined {
  if (!record) return undefined;
  if (record.id) return record.id;
  return entity === "usda-food" && record.fdc_id !== undefined
    ? String(record.fdc_id)
    : undefined;
}

function detailActionRecord(
  record: DetailRecord | undefined,
  sourceId: string | undefined,
): EntityActionRow | undefined {
  if (!record || !sourceId) return undefined;
  return { ...record, id: sourceId };
}

function modeForHash({
  hash,
  overviewIds,
  hasRelations,
  hasActivity,
}: {
  hash: string;
  overviewIds: ReadonlySet<string>;
  hasRelations: boolean;
  hasActivity: boolean;
}): DetailHashResolution {
  const sectionId = normalizedHash(hash);
  if (!sectionId) return { mode: "overview", valid: true };
  if (sectionId === RELATIONS_SECTION_ID) {
    return {
      mode: hasRelations ? "relations" : "overview",
      valid: hasRelations,
    };
  }
  if (sectionId === ACTIVITY_SECTION_ID) {
    return { mode: hasActivity ? "activity" : "overview", valid: hasActivity };
  }
  return {
    mode: "overview",
    valid: overviewIds.has(sectionId),
  };
}

function isDetailMode(value: string): value is DetailMode {
  return value === "overview" || value === "relations" || value === "activity";
}

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

function DetailAnchorIndex({
  sections,
  onSelect,
}: {
  sections: Array<Pick<DetailSection, "id" | "title" | "includeInIndex">>;
  onSelect: (id: string) => void;
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
      className="sticky top-[var(--app-chrome-top)] z-30 flex min-h-11 [scrollbar-width:none] items-stretch overflow-x-auto overscroll-x-contain border-b border-border bg-card px-1 md:min-h-9 md:items-center md:gap-1 md:px-2 [&::-webkit-scrollbar]:hidden"
    >
      <span className="hidden shrink-0 pr-2 text-xs font-medium text-muted-foreground md:block">
        Sections
      </span>
      {indexed.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          aria-current={activeId === section.id ? "location" : undefined}
          onClick={(event) => {
            event.preventDefault();
            onSelect(section.id);
            jump(section.id);
          }}
          className={cn(
            "relative flex min-h-11 shrink-0 items-center px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none md:min-h-0 md:py-1",
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
    <div className="space-y-4 max-md:space-y-0 max-md:divide-y max-md:divide-border max-md:border-y max-md:border-border">
      {blocks}
    </div>
  );
}

interface DetailSectionsProps {
  sections: DetailSection[];
  rawData: unknown;
  heroImages?: Array<{ id: string; url: string; filename: string }>;
  heroMedia?: ReactNode;
  /** Compact, page-authored relationship evidence shown only in Overview. */
  relationshipPreview?: ReactNode;
  /** Page-owned action hosts (such as Image's hero) suppress this generic one. */
  showEntityActions?: boolean;
}

function resolveRelationshipDetail(
  pageDetail: ReturnType<typeof usePageDetailContext>,
  record: DetailRecord | undefined,
  sourceId: string | undefined,
  sections: DetailSection[],
) {
  const ownSection = sections.find(
    (section) => section.id === RELATIONS_SECTION_ID,
  );
  const hasSourceViews = relatedViewRegistry.some(
    (view) => view.source === pageDetail?.entity,
  );
  if (ownSection || !pageDetail || !sourceId || !hasSourceViews) {
    return { ownSection, preview: null, section: ownSection };
  }
  const source = record
    ? relationshipRouteSourceFromRecord(pageDetail.entity, record, sourceId)
    : null;
  const preview = (
    <RelationshipRoutePreview
      entity={pageDetail.entity}
      sourceId={sourceId}
      source={source}
    />
  );
  const genericSection: DetailSection = {
    id: RELATIONS_SECTION_ID,
    title: "Relationships",
    icon: relationshipsSectionIcon,
    placement: "full",
    content: (
      <RelationshipExplorer entity={pageDetail.entity} sourceId={sourceId} />
    ),
  };
  return {
    ownSection,
    preview,
    section: ownSection ?? genericSection,
  };
}

function resolveActivityDetail(
  pageDetail: ReturnType<typeof usePageDetailContext>,
  sourceId: string | undefined,
  sections: DetailSection[],
) {
  const ownSection = sections.find(
    (section) => section.id === ACTIVITY_SECTION_ID,
  );
  if (
    ownSection ||
    !pageDetail ||
    !sourceId ||
    !isAuditableEntity(pageDetail.entity)
  ) {
    return { ownSection, section: ownSection };
  }
  const section: DetailSection = {
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
  };
  return { ownSection, section };
}

function validateDetailSectionIds(
  visibleSections: DetailSection[],
  relationship: ReturnType<typeof resolveRelationshipDetail>,
  activity: ReturnType<typeof resolveActivityDetail>,
) {
  const allSections = [...visibleSections];
  if (!relationship.ownSection && relationship.section) {
    allSections.push(relationship.section);
  }
  if (!activity.ownSection && activity.section) {
    allSections.push(activity.section);
  }
  const ids = allSections.map((section) => section.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Detail section ids must be unique within a record page");
  }
}

function hashForDetailMode(mode: DetailMode) {
  if (mode === "relations") return RELATIONS_SECTION_ID;
  if (mode === "activity") return ACTIVITY_SECTION_ID;
  return undefined;
}

function contextSourceId(
  pageDetail: ReturnType<typeof usePageDetailContext>,
  record: DetailRecord | undefined,
) {
  return pageDetail ? detailSourceId(pageDetail.entity, record) : undefined;
}

function contextActionRecord(
  pageDetail: ReturnType<typeof usePageDetailContext>,
  record: DetailRecord | undefined,
  sourceId: string | undefined,
) {
  return pageDetail ? detailActionRecord(record, sourceId) : undefined;
}

export const DetailSections: FC<DetailSectionsProps> = ({
  sections,
  rawData,
  heroImages,
  heroMedia,
  relationshipPreview: authoredRelationshipPreview,
  showEntityActions = true,
}) => {
  const { isDebugEnabled } = useDebug();
  const pageDetail = usePageDetailContext();
  const parsedDetailRecord = pageDetail
    ? detailRecordSchema.safeParse(pageDetail.rawData)
    : undefined;
  const detailRecord = parsedDetailRecord?.success
    ? parsedDetailRecord.data
    : undefined;
  const locationHash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate();
  const sourceId = contextSourceId(pageDetail, detailRecord);
  const visibleSections = useMemo(
    () =>
      sections.filter(
        (section) => section.content !== null && section.content !== undefined,
      ),
    [sections],
  );
  // A detail page may own a semantically richer relationship composition than
  // the generic explorer. The explicit section wins just as an explicit
  // History section does below; appending both would duplicate the anchor and
  // let the generic graph contradict the page-owned relationship contract.
  const relationshipDetail = resolveRelationshipDetail(
    pageDetail,
    detailRecord,
    sourceId,
    visibleSections,
  );
  const relationshipSection = relationshipDetail.section;
  // Every auditable entity gets its audit trail for free — callers used to
  // hand-wire an identical `AuditLogList` card themselves (five detail pages did,
  // byte-for-byte). The id check is the opt-out: a page that already places its
  // own `id: "history"` section (e.g. via `useEntityDetail`'s commonSections, or
  // a custom placement) keeps that one instead of getting a second.
  const activityDetail = resolveActivityDetail(
    pageDetail,
    sourceId,
    visibleSections,
  );
  const resolvedActivitySection = activityDetail.section;
  const overviewSections = useMemo(
    () =>
      visibleSections.filter(
        (section) =>
          section.id !== RELATIONS_SECTION_ID &&
          section.id !== ACTIVITY_SECTION_ID,
      ),
    [visibleSections],
  );

  // Validate the authored ledger and shared extensions together before
  // partitioning them into modes. A duplicate relationship/history id is still
  // an invalid record page even though only one mode is visible at a time.
  validateDetailSectionIds(visibleSections, relationshipDetail, activityDetail);

  const overviewIdKey = overviewSections
    .map((section) => section.id)
    .join("\u001f");
  const overviewIds = useMemo(
    () => new Set(overviewIdKey ? overviewIdKey.split("\u001f") : []),
    [overviewIdKey],
  );
  const hasRelations = Boolean(relationshipSection);
  const hasActivity = Boolean(resolvedActivitySection);
  const resolveHash = useCallback(
    (hash: string) =>
      modeForHash({ hash, overviewIds, hasRelations, hasActivity }),
    [hasActivity, hasRelations, overviewIds],
  );
  const [activeMode, setActiveMode] = useState<DetailMode>(
    () => resolveHash(locationHash).mode,
  );

  const setHash = useCallback(
    (hash: string | undefined, replace: boolean) => {
      void navigate({
        to: ".",
        hash,
        replace,
        resetScroll: false,
        hashScrollIntoView: false,
      });
    },
    [navigate],
  );

  // TanStack Router updates this value for Link navigation and browser
  // back/forward. That makes Product route branch links switch back to Overview
  // before their formerly hidden section is focused.
  useEffect(() => {
    const resolved = resolveHash(locationHash);
    setActiveMode(resolved.mode);
    if (!resolved.valid) setHash(undefined, true);
  }, [locationHash, resolveHash, setHash]);

  useEffect(() => {
    if (activeMode !== "overview") return;
    const sectionId = normalizedHash(locationHash);
    if (!overviewIds.has(sectionId)) return;
    const target = document.getElementById(sectionId);
    target?.scrollIntoView({ behavior: "auto", block: "start" });
    target?.focus({ preventScroll: true });
  }, [activeMode, locationHash, overviewIds]);

  const selectMode = (nextMode: string) => {
    if (!isDetailMode(nextMode)) return;
    const mode = nextMode;
    if (
      (mode === "relations" && !hasRelations) ||
      (mode === "activity" && !hasActivity)
    ) {
      return;
    }
    setActiveMode(mode);
    setHash(hashForDetailMode(mode), false);
  };

  const selectOverviewSection = (sectionId: string) => {
    setActiveMode("overview");
    setHash(sectionId, true);
  };

  const compactRelationshipPreview =
    authoredRelationshipPreview ?? relationshipDetail.preview;
  const actionRecord = contextActionRecord(pageDetail, detailRecord, sourceId);
  const visual = heroVisual({
    heroImages,
    heroMedia: heroMedia ?? pageDetail?.heroMedia,
  });

  return (
    <Tabs value={activeMode} onValueChange={selectMode} className="gap-2">
      <TabsList
        variant="line"
        aria-label="Record views"
        className="w-full justify-start border-b border-border bg-card px-2 md:px-4"
      >
        <TabsTrigger value="overview">Overview</TabsTrigger>
        {hasRelations ? (
          <TabsTrigger value="relations">Relations</TabsTrigger>
        ) : null}
        {hasActivity ? (
          <TabsTrigger value="activity">Activity</TabsTrigger>
        ) : null}
      </TabsList>

      {activeMode === "overview" ? (
        <TabsContent value="overview" className="text-sm/5">
          <div className="space-y-2 sm:space-y-4">
            <DetailAnchorIndex
              sections={overviewSections}
              onSelect={selectOverviewSection}
            />
            {compactRelationshipPreview}
            {showEntityActions &&
            pageDetail &&
            actionRecord &&
            pageDetail.entity !== "product" ? (
              <Row wrap justify="end" gap="sm" className="px-2 sm:px-0">
                <EntityActionButtons
                  entity={pageDetail.entity}
                  record={actionRecord}
                />
              </Row>
            ) : null}
            <div className="animate-in duration-150 fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none">
              {renderResponsiveLayout({
                sections: overviewSections,
                visual,
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
        </TabsContent>
      ) : null}

      {activeMode === "relations" && relationshipSection ? (
        <TabsContent value="relations" className="text-sm/5">
          <div className="animate-in duration-150 fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none">
            {renderResponsiveLayout({
              sections: [{ ...relationshipSection, placement: "full" }],
            })}
          </div>
        </TabsContent>
      ) : null}

      {activeMode === "activity" && resolvedActivitySection ? (
        <TabsContent value="activity" className="text-sm/5">
          <div className="animate-in duration-150 fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none">
            {renderResponsiveLayout({
              sections: [{ ...resolvedActivitySection, placement: "full" }],
            })}
          </div>
        </TabsContent>
      ) : null}
    </Tabs>
  );
};
