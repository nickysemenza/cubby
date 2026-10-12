import type { Entity } from "@cubby/schemas/entity";
import { isAuditableEntity } from "@cubby/schemas/entity-manifest";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  type FC,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";

import { cn, formatCount } from "~/lib/utils";
import { useDebug } from "~/ui/hooks/useDebug";
import { useHydrated } from "~/ui/hooks/useHydrated";
import { usePageDetailContext } from "~/ui/page/Page";
import { Button } from "~/ui/primitives/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/ui/primitives/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

import { EntityHero } from "../../entity/components/EntityHero";
import {
  EntityRelations,
  supportsEntityGraph,
} from "../../entity/relationships/entity-relations";
import { relationshipsSectionIcon } from "../../entity/relationships/relationship-tree";
import { AuditLogList } from "../../features/audit-log/audit-log-list";
import JsonRenderer from "../json-renderer";
import {
  ContinuousDetailContext,
  SectionCountContext,
  SectionEmptyContext,
  SectionEmptyRegistryContext,
} from "./detail-section-state";

/** Stable id every auto-appended Activity section uses — also the opt-out key: a
 * caller that already supplies a section with this id (e.g. a page composing its
 * own custom activity placement) keeps its own instead of getting a second one. */
const ACTIVITY_SECTION_ID = "history";
const RELATIONS_SECTION_ID = "relationships";

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

type DetailPlacement = "primary" | "supporting" | "full";

export interface DetailSection {
  /** Stable DOM id and section-index target. */
  id: string;
  title: string;
  content: React.ReactNode;
  icon: React.ElementType;
  /** Explicit narrative role; there is deliberately no automatic default. */
  placement: DetailPlacement;
  /** Supporting sections join Evidence unless an explicit workspace owns them. */
  overview?: boolean;
  workspace?: "overview" | "work" | "evidence";
  /** Exclude low-value/debug regions from the jump index. */
  includeInIndex?: boolean;
  /** Right-aligned header slot: a toolbar, action cluster, or rolled-up stat. */
  headerAction?: ReactNode;
  /** Let inline popovers/comboboxes escape the ruled section card. */
  overflowVisible?: boolean;
  /** Specialized workflows can supply their own internal surface while retaining
   * the shared index, relationship, activity, and debug extensions. */
  surface?: "card" | "plain";
  /** Resolved emptiness for sections whose data is already in the detail record. */
  empty?: boolean;
}

function SectionCard({
  section,
  className,
}: {
  section: DetailSection;
  className?: string;
}) {
  const [count, setCount] = useState<number | undefined>(undefined);
  const [reportedEmpty, setEmpty] = useState(false);
  const register = useContext(SectionEmptyRegistryContext);
  const continuous = useContext(ContinuousDetailContext);
  const empty =
    section.empty === true ||
    reportedEmpty ||
    count === 0 ||
    section.content == null;
  useEffect(() => {
    register?.(section.id, empty);
    return () => register?.(section.id, false);
  }, [register, section.id, empty]);
  const Heading = continuous ? "h3" : "h2";
  return (
    <SectionEmptyContext.Provider value={setEmpty}>
      <SectionCountContext.Provider value={setCount}>
        <section
          id={section.id}
          aria-labelledby={`${section.id}-heading`}
          tabIndex={-1}
          data-empty={empty || undefined}
          data-detail-section
          className={cn(
            "scroll-mt-[calc(var(--app-chrome-top)+3rem)] focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            section.surface !== "plain" && "px-3 py-3 md:py-2",
            section.overflowVisible
              ? "overflow-visible"
              : "[contain-intrinsic-size:auto_320px] [content-visibility:auto]",
            className,
          )}
        >
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 max-md:items-center">
            <div className="flex min-w-0 items-center gap-2">
              <Heading
                id={`${section.id}-heading`}
                className={cn(
                  "flex min-w-0 items-center gap-2 text-sm font-semibold tracking-tight",
                  empty && "text-muted-foreground",
                )}
              >
                <section.icon className="size-3.5 shrink-0 text-muted-foreground" />
                {section.title}
              </Heading>
              {empty ? (
                <span
                  id={`${section.id}-empty`}
                  className="text-xs text-muted-foreground"
                >
                  Empty
                </span>
              ) : count !== undefined ? (
                <span className="text-xs text-muted-foreground">
                  {formatCount(count)}
                </span>
              ) : null}
            </div>
            {section.headerAction ? (
              <div className="max-w-full min-w-0">{section.headerAction}</div>
            ) : null}
          </div>
          <div className="mt-2 md:mt-1.5">
            {section.content ?? (
              <p className="text-sm text-muted-foreground">No items.</p>
            )}
          </div>
        </section>
      </SectionCountContext.Provider>
    </SectionEmptyContext.Provider>
  );
}

function SectionPlane({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border rounded-xl border border-border bg-card">
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

type DetailGroup = { id: string; title: string; sections: DetailSection[] };

function hashForDetailTarget(id: string, groups: DetailGroup[]) {
  const alias = id.replace("detail-group-", "");
  return groups.some((group) =>
    group.sections.some((section) => section.id === alias),
  )
    ? id
    : alias;
}

const currentDetailAnchorClass =
  "bg-muted font-medium before:absolute before:inset-y-1.5 before:start-1 before:w-0.5 before:rounded-full before:bg-foreground";

function DetailAnchorIndex({
  groups,
  emptySections,
  activeId,
  wide,
  onSelect,
}: {
  groups: DetailGroup[];
  emptySections: ReadonlyMap<string, boolean>;
  activeId: string | undefined;
  wide: boolean;
  onSelect: (id: string) => void;
}) {
  const navigationRef = useRef<HTMLElement>(null);
  const menuTargetRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const nav = navigationRef.current;
    const active = nav?.querySelector<HTMLElement>(
      'a[aria-current="location"]',
    );
    if (!wide || !nav || !active) return;
    const viewport = nav.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.top < viewport.top) nav.scrollTop += item.top - viewport.top;
    else if (item.bottom > viewport.bottom)
      nav.scrollTop += item.bottom - viewport.bottom;
  }, [activeId, wide]);
  const selectMenuTarget = (id: string) => {
    menuTargetRef.current = document.getElementById(id);
    onSelect(id);
  };
  const activeTitle =
    groups
      .flatMap((group) => [group, ...group.sections])
      .find((entry) => entry.id === activeId)?.title ?? groups[0]?.title;
  const entryState = (id: string) => ({
    "aria-current": activeId === id ? ("location" as const) : undefined,
    "aria-describedby": emptySections.get(id) ? `${id}-empty` : undefined,
  });
  return (
    <div
      className={cn(
        "sticky top-[var(--app-chrome-top)] z-30 self-start",
        wide ? "w-44 shrink-0" : "bg-background",
      )}
    >
      <nav
        ref={navigationRef}
        aria-label="Section index"
        className={cn(
          "max-h-[calc(100dvh-var(--app-chrome-top)-1rem)] overflow-y-auto overscroll-contain py-2 pr-3 text-xs",
          !wide && "hidden",
        )}
      >
        {groups.map((group) => (
          <div key={group.id} className="mb-3 last:mb-0">
            <a
              href={`#${hashForDetailTarget(group.id, groups)}`}
              {...entryState(group.id)}
              className={cn(
                "relative block rounded-md px-2 py-1.5 font-semibold hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                activeId === group.id && currentDetailAnchorClass,
              )}
              onClick={(event) => {
                event.preventDefault();
                onSelect(group.id);
              }}
            >
              {group.title}
            </a>
            <ul className="mt-0.5 space-y-0.5">
              {group.sections
                .filter((section) => section.includeInIndex !== false)
                .map((section) => (
                  <li key={section.id}>
                    <a
                      href={`#${section.id}`}
                      {...entryState(section.id)}
                      aria-label={section.title}
                      aria-describedby={
                        emptySections.get(section.id)
                          ? `${section.id}-empty`
                          : undefined
                      }
                      className={cn(
                        "relative flex min-h-7 items-center justify-between gap-2 rounded-md py-1 pr-2 pl-4 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                        activeId === section.id && currentDetailAnchorClass,
                        activeId === section.id &&
                          !emptySections.get(section.id) &&
                          "text-foreground",
                      )}
                      onClick={(event) => {
                        event.preventDefault();
                        onSelect(section.id);
                      }}
                    >
                      <span>{section.title}</span>
                      {emptySections.get(section.id) && (
                        <span className="text-[11px] font-normal text-muted-foreground">
                          Empty
                        </span>
                      )}
                    </a>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </nav>
      {!wide && (
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) menuTargetRef.current = null;
          }}
        >
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                className="min-h-11 w-full justify-between px-2 text-muted-foreground"
              />
            }
          >
            <span className="min-w-0 truncate">
              Jump to:{" "}
              <span className="font-medium text-foreground">{activeTitle}</span>
            </span>
            <CaretDownIcon className="size-3.5 shrink-0" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            finalFocus={() => menuTargetRef.current ?? true}
            className="max-h-[70dvh] w-72 overflow-y-auto"
          >
            {groups.map((group, index) => (
              <div key={group.id}>
                {index > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  render={
                    <a
                      href={`#${hashForDetailTarget(group.id, groups)}`}
                      aria-label={group.title}
                    />
                  }
                  className="font-semibold"
                  onClick={(event) => {
                    event.preventDefault();
                    selectMenuTarget(group.id);
                  }}
                >
                  {group.title}
                </DropdownMenuItem>
                {group.sections
                  .filter((section) => section.includeInIndex !== false)
                  .map((section) => (
                    <DropdownMenuItem
                      key={section.id}
                      render={
                        <a href={`#${section.id}`} aria-label={section.title} />
                      }
                      {...entryState(section.id)}
                      onClick={(event) => {
                        event.preventDefault();
                        selectMenuTarget(section.id);
                      }}
                    >
                      <span className="min-w-0 flex-1">{section.title}</span>
                      {emptySections.get(section.id) && (
                        <span className="text-xs text-muted-foreground">
                          Empty
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))}
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
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
          "grid items-start gap-3 md:gap-3",
          primary.length > 0 && hasSupportingRail
            ? "@min-[60rem]/detail-body:grid-cols-[minmax(0,1fr)_20rem]"
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
              <div
                data-testid="detail-rail-media"
                className="hidden max-w-80 md:block"
              >
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
  return (
    <div className="@container/detail-body space-y-4 md:space-y-2">
      {blocks}
    </div>
  );
}

interface DetailSectionsProps {
  onlyWorkspace?: "evidence";
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
        entityKind={pageDetail.entity}
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

function contextSourceId(
  pageDetail: ReturnType<typeof usePageDetailContext>,
  record: DetailRecord | undefined,
) {
  return pageDetail ? detailSourceId(pageDetail.entity, record) : undefined;
}

export const DetailSections: FC<DetailSectionsProps> = ({
  onlyWorkspace,
  sections,
  rawData,
  heroImages,
  heroMedia,
}) => {
  const hydrated = useHydrated();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    setWide(element.getBoundingClientRect().width >= 800);
    if (!("ResizeObserver" in window)) return;
    const observer = new ResizeObserver((entries) =>
      setWide((entries[0]?.contentRect.width ?? 0) >= 800),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { isDebugEnabled } = useDebug();
  const pageDetail = usePageDetailContext();
  const parsedDetailRecord = pageDetail
    ? detailRecordSchema.safeParse(rawData)
    : undefined;
  const detailRecord = parsedDetailRecord?.success
    ? parsedDetailRecord.data
    : undefined;
  const sourceId = contextSourceId(pageDetail, detailRecord);
  const relationship = useMemo(
    () => resolveRelationshipDetail(pageDetail, sourceId, sections),
    [pageDetail, sourceId, sections],
  );
  const activity = useMemo(
    () => resolveActivityDetail(pageDetail, sourceId, sections),
    [pageDetail, sourceId, sections],
  );
  validateDetailSectionIds(sections, relationship, activity);
  const groups = useMemo(() => {
    const groupSections = (workspace: "overview" | "work" | "evidence") =>
      sections.filter(
        (section) =>
          section.id !== RELATIONS_SECTION_ID &&
          section.id !== ACTIVITY_SECTION_ID &&
          (section.workspace ??
            (section.overview === false ? "evidence" : "overview")) ===
            workspace,
      );
    const result: DetailGroup[] = [
      {
        id: "detail-group-overview",
        title: "Overview",
        sections: groupSections("overview"),
      },
      {
        id: "detail-group-work",
        title: "Work",
        sections: groupSections("work"),
      },
      {
        id: "detail-group-evidence",
        title: "Evidence",
        sections: groupSections("evidence"),
      },
      {
        id: "detail-group-relations",
        title: "Relations",
        sections: relationship.section ? [relationship.section] : [],
      },
      {
        id: "detail-group-activity",
        title: "Activity",
        sections: activity.section ? [activity.section] : [],
      },
    ];
    return result.filter((group) => group.sections.length > 0);
  }, [sections, relationship.section, activity.section]);
  const [emptySections, setEmptySections] = useState<Map<string, boolean>>(
    new Map(),
  );
  const registerEmpty = useCallback((id: string, empty: boolean) => {
    setEmptySections((previous) =>
      previous.get(id) === empty ? previous : new Map(previous).set(id, empty),
    );
  }, []);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const jumpTargetRef = useRef<
    | {
        id: string;
        positions: Map<Element, number>;
      }
    | undefined
  >(undefined);
  const locationHash = useLocation({ select: (location) => location.hash });
  const scrollIntentRef = useRef(false);
  const navigate = useNavigate();
  const targetForHash = useCallback((hash: string) => {
    const id = normalizedHash(hash);
    const direct = document.getElementById(id);
    if (direct && workspaceRef.current?.contains(direct)) return id;
    const group = document.getElementById(`detail-group-${id}`);
    return group && workspaceRef.current?.contains(group) ? group.id : id;
  }, []);
  const focusTarget = useCallback((id: string) => {
    const target = document.getElementById(id);
    if (!target || !workspaceRef.current?.contains(target)) return;
    target.scrollIntoView({ behavior: "instant", block: "start" });
    target.focus({ preventScroll: true });
    const positions = new Map<Element, number>();
    for (
      let ancestor: HTMLElement | null = target;
      ancestor;
      ancestor = ancestor.parentElement
    )
      positions.set(ancestor, ancestor.scrollTop);
    jumpTargetRef.current = { id, positions };
    scrollIntentRef.current = false;
    setActiveId(id);
  }, []);
  const selectSection = (id: string) => {
    focusTarget(id);
    void navigate({
      to: ".",
      hash: hashForDetailTarget(id, groups),
      replace: false,
      resetScroll: false,
      hashScrollIntoView: false,
    });
  };
  // A fragment selects a location, never a hidden view. Back/forward and repeated
  // links preserve mounted editors; invalid fragments leave the page readable.
  useEffect(() => {
    if (hydrated && locationHash && !onlyWorkspace)
      focusTarget(targetForHash(locationHash));
  }, [hydrated, locationHash, onlyWorkspace, targetForHash, focusTarget]);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !hydrated) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const targets = Array.from(
        body.querySelectorAll<HTMLElement>(
          "[data-detail-group], [data-detail-section]",
        ),
      );
      const top = targets[0]
        ? parseFloat(getComputedStyle(targets[0]).scrollMarginTop) || 88
        : 88;
      // A clamped jump can leave its heading below the reading line. Preserve
      // the explicit destination until scrolling moves away or the user scrolls.
      const jumped = targets.find(
        (target) => target.id === jumpTargetRef.current?.id,
      );
      const jumpedRect = jumped?.getBoundingClientRect();
      if (
        jumped &&
        jumpedRect &&
        jumpedRect.bottom > 0 &&
        jumpedRect.top < window.innerHeight
      ) {
        setActiveId(jumped.id);
        return;
      }
      jumpTargetRef.current = undefined;
      const current =
        body.getBoundingClientRect().bottom <= window.innerHeight + 1
          ? targets.at(-1)
          : (targets
              .filter((target) => target.getBoundingClientRect().top <= top + 1)
              .at(-1) ?? targets[0]);
      if (current) setActiveId(current.id);
    };
    const schedule = (event?: Event) => {
      const scroller =
        event?.target instanceof Element
          ? event.target
          : document.scrollingElement;
      const prior = scroller && jumpTargetRef.current?.positions.get(scroller);
      if (
        event?.type === "scroll" &&
        scrollIntentRef.current &&
        scroller &&
        prior != null &&
        Math.abs(scroller.scrollTop - prior) > 1
      )
        jumpTargetRef.current = undefined;
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onScrollIntent = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (event.type === "pointerdown") {
        if (jumpTargetRef.current?.positions.has(target))
          scrollIntentRef.current = true;
        return;
      }
      if (
        !body.contains(target) &&
        !jumpTargetRef.current?.positions.has(target)
      )
        return;
      if (event instanceof KeyboardEvent) {
        if (
          ![
            "ArrowUp",
            "ArrowDown",
            "PageUp",
            "PageDown",
            "Home",
            "End",
            " ",
          ].includes(event.key) ||
          target.closest(
            'input,textarea,select,[contenteditable],[role="menu"],[role="listbox"]',
          )
        )
          return;
      }
      scrollIntentRef.current = true;
    };
    update();
    document.addEventListener("wheel", onScrollIntent, { passive: true });
    document.addEventListener("touchmove", onScrollIntent, { passive: true });
    document.addEventListener("pointerdown", onScrollIntent);
    document.addEventListener("keydown", onScrollIntent);
    document.addEventListener("scroll", schedule, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", schedule);
    const observer =
      "ResizeObserver" in window
        ? new ResizeObserver(() => {
            const id = jumpTargetRef.current?.id;
            if (
              id &&
              !scrollIntentRef.current &&
              document.activeElement?.id === id
            )
              focusTarget(id);
            schedule();
          })
        : undefined;
    observer?.observe(body);
    return () => {
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("wheel", onScrollIntent);
      document.removeEventListener("touchmove", onScrollIntent);
      document.removeEventListener("pointerdown", onScrollIntent);
      document.removeEventListener("keydown", onScrollIntent);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [hydrated, groups, focusTarget]);
  const visual = heroVisual({
    heroImages,
    heroMedia: heroMedia ?? pageDetail?.heroMedia,
  });
  if (onlyWorkspace === "evidence")
    return (
      <div className="space-y-2" data-run-evidence>
        {renderSectionStack(
          sections.filter((section) => section.workspace === "evidence"),
        )}
      </div>
    );
  return (
    <div
      ref={workspaceRef}
      className={cn("min-w-0", wide ? "flex items-start gap-4" : "space-y-2")}
    >
      <ContinuousDetailContext.Provider value>
        <SectionEmptyRegistryContext.Provider value={registerEmpty}>
          <DetailAnchorIndex
            groups={groups}
            emptySections={emptySections}
            activeId={activeId}
            wide={wide}
            onSelect={selectSection}
          />
          <div ref={bodyRef} className="min-w-0 flex-1 space-y-6 text-sm/5">
            {groups.map((group, index) => (
              <div
                key={group.id}
                id={group.id}
                data-detail-group
                tabIndex={-1}
                className="scroll-mt-[calc(var(--app-chrome-top)+3rem)] space-y-2 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <h2 className="px-1 text-base font-semibold tracking-tight">
                  {group.title}
                </h2>
                {renderResponsiveLayout({
                  sections: group.sections,
                  visual: index === 0 ? visual : undefined,
                })}
              </div>
            ))}
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
        </SectionEmptyRegistryContext.Provider>
      </ContinuousDetailContext.Provider>
    </div>
  );
};
