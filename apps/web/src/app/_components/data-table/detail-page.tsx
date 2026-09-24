import type { Entity } from "@cubby/schemas/entity";
import { isAuditableEntity } from "@cubby/schemas/entity-manifest";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  createContext,
  type FC,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { z } from "zod";

import { usePageDetailContext } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useDebug } from "~/hooks/useDebug";
import { cn, formatCount } from "~/lib/utils";

import { AuditLogList } from "../audit-log/audit-log-list";
import { EntityHero } from "../EntityHero";
import JsonRenderer from "../json-renderer";
import {
  EntityRelations,
  supportsEntityGraph,
} from "../relationships/entity-relations";
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
    fdc_id: z.number().nullish(),
    name: z.string().nullish(),
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
  return entity === "usda-food" && record.fdc_id != null
    ? String(record.fdc_id)
    : undefined;
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
  /** Starts folded; the body mounts only once opened (a heavy analytics view). */
  collapsed?: boolean;
}

/**
 * A relation/list section reports its true row count up through here so the
 * section's own `<h2>` can carry it (mono, secondary) without the section
 * body reaching back into the header it doesn't render. Mirrors
 * `usePageCount`: an effect-based report, `undefined` cleans it back up on
 * unmount, and a call outside a `SectionCard` body is a safe no-op.
 */
const SectionCountContext = createContext<
  ((count: number | undefined) => void) | null
>(null);

export function useSectionCount(count: number | undefined) {
  const setCount = useContext(SectionCountContext);
  useEffect(() => {
    setCount?.(count);
    return () => setCount?.(undefined);
  }, [setCount, count]);
}

/**
 * A `hideWhenEmpty` relation section reports here once its first page
 * resolves — `false` hides the whole `SectionCard` (header, "+Add", body),
 * not just the body, so a section nobody asked to see leaves no trace it was
 * ever declared. Hidden through the `hidden` attribute rather than an
 * unmount: the section's own data hook (`useEntityList`) stays mounted, so a
 * later create doesn't force it to refetch from scratch, and `[hidden]`
 * already drops the subtree from the accessibility tree and from
 * `getByRole` queries. Mirrors `useSectionCount`: an effect-based report, a
 * call outside a `SectionCard` body is a safe no-op, and unmounting restores
 * visibility.
 */
const SectionVisibilityContext = createContext<
  ((visible: boolean) => void) | null
>(null);

export function useSectionVisible(visible: boolean) {
  const setVisible = useContext(SectionVisibilityContext);
  useEffect(() => {
    setVisible?.(visible);
    return () => setVisible?.(true);
  }, [setVisible, visible]);
}

/**
 * A `collapseWhenEmpty` relation section reports here once its first page
 * resolves empty: the card keeps its header (title, `0` count, "+Add") and
 * hides only the body, so an empty relation stays one line tall yet still
 * offers its first create. Same effect-based shape as `useSectionVisible`.
 */
const SectionCollapsedContext = createContext<
  ((collapsed: boolean) => void) | null
>(null);

export function useSectionCollapsed(collapsed: boolean) {
  const setCollapsed = useContext(SectionCollapsedContext);
  useEffect(() => {
    setCollapsed?.(collapsed);
    return () => setCollapsed?.(false);
  }, [setCollapsed, collapsed]);
}

/**
 * Mirrors each `SectionCard`'s own (per-card) visibility up to `DetailSections`,
 * keyed by section id, so the jump index (`DetailAnchorIndex`) can drop a
 * `hideWhenEmpty` section that is currently hidden instead of always listing
 * every declared section regardless of the `hidden` attribute `SectionCard`
 * sets on itself. A section absent from the map hasn't reported yet and is
 * treated as visible.
 */
const SectionVisibilityRegistryContext = createContext<
  ((id: string, visible: boolean) => void) | null
>(null);

function SectionCard({
  section,
  className,
}: {
  section: DetailSection;
  className?: string;
}) {
  // Starts open unless the declaration folds it; the body only ever mounts
  // (and so can only ever report a count) once it's open — a collapsed
  // section shows no count.
  const [open, setOpen] = useState(!section.collapsed);
  const [count, setCount] = useState<number | undefined>(undefined);
  const [visible, setVisible] = useState(true);
  const [bodyCollapsed, setBodyCollapsed] = useState(false);
  const registerVisibility = useContext(SectionVisibilityRegistryContext);
  const sectionId = section.id;
  const reportVisible = useCallback(
    (next: boolean) => {
      setVisible(next);
      registerVisibility?.(sectionId, next);
    },
    [registerVisibility, sectionId],
  );

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

  const heading = (
    <>
      <section.icon
        className={cn(
          "size-3.5 shrink-0",
          section.collapsed && !open ? "text-muted-foreground" : "text-slate",
        )}
      />
      {section.title}
      {open && count !== undefined ? (
        <span className="font-mono text-2xs font-normal text-muted-foreground">
          {formatCount(count)}
        </span>
      ) : null}
    </>
  );

  return (
    <SectionVisibilityContext.Provider value={reportVisible}>
      <section
        id={section.id}
        tabIndex={-1}
        hidden={!visible}
        className={cn(
          "scroll-mt-[calc(var(--app-chrome-top)+3rem)] px-3 py-3 focus:outline-none md:px-3 md:py-2",
          section.overflowVisible && "overflow-visible",
          className,
        )}
      >
        {/* Phone header actions are 44px targets, so the row centres there;
            desktop's 28px ghosts sit flush with the title's first line. */}
        <div className="flex items-start justify-between gap-3 max-md:items-center">
          <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold tracking-tight">
            {section.collapsed ? (
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((current) => !current)}
                className="flex min-w-0 items-center gap-2 font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <CaretRightIcon
                  className={cn(
                    "size-3.5 shrink-0 transition-transform",
                    open && "rotate-90",
                  )}
                />
                {heading}
              </button>
            ) : (
              heading
            )}
          </h2>
          {section.headerAction && (!section.collapsed || open) ? (
            <div className="shrink-0">{section.headerAction}</div>
          ) : null}
        </div>
        {open ? (
          <SectionCountContext.Provider value={setCount}>
            <SectionCollapsedContext.Provider value={setBodyCollapsed}>
              <div className="mt-2 md:mt-1.5" hidden={bodyCollapsed}>
                {section.content}
              </div>
            </SectionCollapsedContext.Provider>
          </SectionCountContext.Provider>
        ) : null}
      </section>
    </SectionVisibilityContext.Provider>
  );
}

function SectionPlane({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card max-md:rounded-none max-md:border-x-0">
      {children}
    </div>
  );
}

function renderSectionStack(sections: DetailSection[]) {
  const blocks: ReactNode[] = [];
  let ruled: DetailSection[] = [];

  const flushRuled = () => {
    if (ruled.length === 0) return;
    const current = ruled;
    ruled = [];
    blocks.push(
      <SectionPlane key={`plane-${blocks.length}`}>
        {current.map((section) => (
          <SectionCard key={section.id} section={section} />
        ))}
      </SectionPlane>,
    );
  };

  for (const section of sections) {
    if (section.surface === "plain") {
      flushRuled();
      blocks.push(<SectionCard key={section.id} section={section} />);
    } else {
      ruled.push(section);
    }
  }
  flushRuled();

  return blocks;
}

function renderFullSection(section: DetailSection) {
  return section.surface === "plain" ? (
    <SectionCard key={section.id} section={section} />
  ) : (
    <SectionPlane key={section.id}>
      <SectionCard section={section} />
    </SectionPlane>
  );
}

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

  const activeTitle =
    indexed.find((section) => section.id === activeId)?.title ??
    indexed[0]?.title;

  return (
    <>
      {/* md+: an inline anchor list, hairline-left, same IntersectionObserver. */}
      <nav
        aria-label="Section index"
        className="hidden min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-l border-border pl-2 text-xs text-muted-foreground md:flex"
      >
        {indexed.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            aria-current={activeId === section.id ? "location" : undefined}
            className={cn(
              "transition-colors hover:text-foreground",
              activeId === section.id && "font-medium text-foreground",
            )}
            onClick={(event) => {
              event.preventDefault();
              onSelect(section.id);
              jump(section.id);
            }}
          >
            {section.title}
          </a>
        ))}
      </nav>
      {/* Below md: a 44px "Jump to: <active>" bar opening the same list. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              className="min-h-11 w-full min-w-0 justify-between px-0 text-muted-foreground hover:text-foreground md:hidden"
            />
          }
        >
          <span className="min-w-0 truncate">
            Jump to:{" "}
            <span className="font-medium text-foreground">{activeTitle}</span>
          </span>
          <CaretDownIcon className="size-3.5 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          {indexed.map((section) => (
            <DropdownMenuItem
              key={section.id}
              render={<a href={`#${section.id}`} aria-label={section.title} />}
              aria-current={activeId === section.id ? "location" : undefined}
              onClick={(event) => {
                event.preventDefault();
                onSelect(section.id);
                jump(section.id);
              }}
            >
              {section.title}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function DetailCommandStrip({
  activeMode,
  hasRelations,
  hasActivity,
  hasOverviewTools,
  overviewSections,
  onSelectOverviewSection,
}: {
  activeMode: DetailMode;
  hasRelations: boolean;
  hasActivity: boolean;
  hasOverviewTools: boolean;
  overviewSections: DetailSection[];
  onSelectOverviewSection: (sectionId: string) => void;
}) {
  const showOverviewTools = activeMode === "overview" && hasOverviewTools;
  return (
    <div className="sticky top-[var(--app-chrome-top)] z-30 border-y border-border bg-card">
      <div className="flex min-h-11 flex-wrap items-stretch md:min-h-9 md:flex-nowrap md:items-center md:px-2">
        <TabsList
          variant="line"
          aria-label="Record views"
          className="h-11 w-full justify-start px-1 md:h-9 md:w-auto md:px-0"
        >
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {hasRelations ? (
            <TabsTrigger value="relations">Relations</TabsTrigger>
          ) : null}
          {hasActivity ? (
            <TabsTrigger value="activity">Activity</TabsTrigger>
          ) : null}
        </TabsList>
        {/* Verbs live on the plate now — this strip's right side carries only
            the overview section index. */}
        {showOverviewTools ? (
          <div
            data-testid="detail-overview-tools"
            className="flex min-h-11 w-full min-w-0 items-center gap-2 border-t border-border px-2 md:min-h-0 md:flex-1 md:border-t-0 md:px-0 md:pl-2"
          >
            <DetailAnchorIndex
              sections={overviewSections}
              onSelect={onSelectOverviewSection}
            />
          </div>
        ) : null}
      </div>
    </div>
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

    if (!primary.length && !hasSupportingRail) return;
    blocks.push(
      <div
        key={`run-${blocks.length}`}
        className={cn(
          "grid items-start gap-4 md:gap-2",
          primary.length > 0 && hasSupportingRail
            ? "md:grid-cols-[minmax(0,3fr)_minmax(17rem,2fr)] lg:grid-cols-[minmax(0,1fr)_20rem]"
            : "grid-cols-1",
        )}
      >
        {primary.length > 0 ? (
          <div
            data-testid="detail-primary-stack"
            className="min-w-0 space-y-4 md:space-y-2"
          >
            {renderSectionStack(primary)}
          </div>
        ) : null}
        {hasSupportingRail ? (
          <aside
            data-testid="detail-supporting-rail"
            className="min-w-0 space-y-4 md:space-y-2"
          >
            {pendingVisual ? (
              <div data-testid="detail-rail-media" className="hidden md:block">
                {pendingVisual}
              </div>
            ) : null}
            {renderSectionStack(supporting)}
          </aside>
        ) : null}
      </div>,
    );
    visualPlaced = true;
  };

  for (const section of sections) {
    if (section.placement === "full") {
      flushRun();
      blocks.push(renderFullSection(section));
    } else {
      run.push(section);
    }
  }
  flushRun();
  return <div className="space-y-4 md:space-y-2">{blocks}</div>;
}

interface DetailSectionsProps {
  sections: DetailSection[];
  rawData: unknown;
  heroImages?: Array<{ id: string; url: string; filename: string }>;
  heroMedia?: ReactNode;
}

function resolveRelationshipDetail(
  pageDetail: ReturnType<typeof usePageDetailContext>,
  sourceId: string | undefined,
  sections: DetailSection[],
) {
  const ownSection = sections.find(
    (section) => section.id === RELATIONS_SECTION_ID,
  );
  const hasSourceViews = pageDetail && supportsEntityGraph(pageDetail.entity);
  if (ownSection || !pageDetail || !sourceId || !hasSourceViews) {
    return { ownSection, section: ownSection };
  }
  const genericSection: DetailSection = {
    id: RELATIONS_SECTION_ID,
    title: "Relationships",
    icon: relationshipsSectionIcon,
    placement: "full",
    content: <EntityRelations entity={pageDetail.entity} sourceId={sourceId} />,
  };
  return {
    ownSection,
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
    icon: ClockIcon,
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

export const DetailSections: FC<DetailSectionsProps> = ({
  sections,
  rawData,
  heroImages,
  heroMedia,
}) => {
  const { isDebugEnabled } = useDebug();
  const pageDetail = usePageDetailContext();
  const parsedDetailRecord = pageDetail
    ? detailRecordSchema.safeParse(rawData)
    : undefined;
  const detailRecord = parsedDetailRecord?.success
    ? parsedDetailRecord.data
    : undefined;
  const locationHash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate();
  const sourceId = contextSourceId(pageDetail, detailRecord);
  // Per-`SectionCard` `hideWhenEmpty` visibility, mirrored up here by id so
  // the jump index can drop a hidden section instead of always listing every
  // declared one (`SectionVisibilityRegistryContext`/`reportVisible` above).
  const [sectionVisibility, setSectionVisibility] = useState<
    Map<string, boolean>
  >(new Map());
  const registerSectionVisibility = useCallback((id: string, next: boolean) => {
    setSectionVisibility((prev) =>
      prev.get(id) === next ? prev : new Map(prev).set(id, next),
    );
  }, []);
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
    sourceId,
    visibleSections,
  );
  const relationshipSection = relationshipDetail.section;
  // Every auditable entity gets its audit trail for free. The id check is the
  // opt-out: a page that already places its own `id: "history"` section
  // keeps that one instead of getting a second.
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

  // A `hideWhenEmpty` section currently hidden (per `sectionVisibility`, kept
  // live by `SectionCard`/`reportVisible`) drops out of the jump index even
  // though it stays mounted in the overview layout below — a section absent
  // from the map hasn't reported yet and counts as visible.
  const indexEligibleSections = overviewSections.filter(
    (section) => sectionVisibility.get(section.id) !== false,
  );
  const hasOverviewTools =
    indexEligibleSections.filter((section) => section.includeInIndex !== false)
      .length >= 2;
  const visual = heroVisual({
    heroImages,
    heroMedia: heroMedia ?? pageDetail?.heroMedia,
  });

  return (
    <SectionVisibilityRegistryContext.Provider
      value={registerSectionVisibility}
    >
      <Tabs
        value={activeMode}
        onValueChange={selectMode}
        className="gap-4 md:gap-2"
      >
        <DetailCommandStrip
          activeMode={activeMode}
          hasRelations={hasRelations}
          hasActivity={hasActivity}
          hasOverviewTools={hasOverviewTools}
          overviewSections={indexEligibleSections}
          onSelectOverviewSection={selectOverviewSection}
        />

        {activeMode === "overview" ? (
          <TabsContent value="overview" className="text-sm/5">
            <div className="space-y-4 md:space-y-2">
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
    </SectionVisibilityRegistryContext.Provider>
  );
};
