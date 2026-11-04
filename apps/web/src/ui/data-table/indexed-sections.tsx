import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  type ComponentProps,
  type ElementType,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { formatCount } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { EmptyState } from "~/ui/feedback/empty-state";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Section } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

import {
  ContinuousDetailContext,
  SectionCountContext,
  SectionEmptyContext,
  SectionIndexRegistryContext,
  type SectionIndexState,
} from "./detail-section-state";

/** One titled, anchored section in an indexed page. */
export interface IndexedSection {
  /** Stable DOM id and section-index target. */
  id: string;
  title: string;
  /** Quiet line under the heading. */
  description?: ReactNode;
  content: ReactNode;
  icon: ElementType;
  /** Optional marker beside the label in contents navigation and Jump to. */
  indexLeading?: ReactNode;
  /** Exclude low-value/debug regions from the jump index. */
  includeInIndex?: boolean;
  /** Right-aligned header slot: a toolbar, action cluster, or rolled-up stat. */
  headerAction?: ReactNode;
  /** Let inline popovers/comboboxes escape the ruled section card. */
  overflowVisible?: boolean;
  /** Resolved emptiness for sections whose data is already in the record. */
  empty?: boolean;
  /** Row count for a list section whose rows are already loaded; async lists
   * report theirs through `useSectionCount`. */
  count?: number;
  /** Execution evidence may start folded without removing its anchor. */
  collapsed?: boolean;
  /** Count from a batched read, shown until the mounted list reports its own. */
  knownCount?: number;
  /**
   * Record details only: resolved emptiness folds this section into its group's
   * one quiet line and out of the index. `undefined` keeps today's behaviour:
   * Settings and analytics show every section. Unknown or failed reads never
   * report empty, so they stay expanded.
   */
  foldWhenEmpty?: boolean;
  /** A batched read already proved no rows, so the body need not mount. */
  knownEmpty?: boolean;
  /** Set this section beside a later one in the same list where width allows. */
  pairWith?: string;
  /** Still waiting on the batched read: neither mounted nor reported empty. */
  countPending?: boolean;
  /** A section leading a page has no group heading above it. */
  headingAs?: "h2";
  /** The declared section has no title of its own: it renders no heading. */
  bare?: boolean;
}

/** A group heading and its sections. Ids use `detail-group-<key>`, so `#<key>` reaches it. */
export interface IndexedSectionGroup {
  id: string;
  title: string;
  sections: IndexedSection[];
}

export function normalizedHash(hash: string) {
  return hash.startsWith("#") ? hash.slice(1) : hash;
}

/**
 * Two sections side by side at 1000px of available workspace, else stacked.
 * Auto-placed columns let the survivor take the full width when its partner is
 * hidden (an empty Needs you, a folded section), with no reflow code.
 */
export function SectionPair({ children }: { children: ReactNode }) {
  return (
    <div
      data-section-pair
      className="grid min-w-0 grid-cols-1 gap-(--section-gap) @min-[1000px]/record:auto-cols-[minmax(0,1fr)] @min-[1000px]/record:grid-flow-col @min-[1000px]/record:grid-cols-none"
    >
      {children}
    </div>
  );
}

const sectionIsFolded = (
  section: IndexedSection,
  state: SectionIndexState | undefined,
) =>
  section.foldWhenEmpty === true &&
  (section.knownEmpty === true || state?.empty === true);

function SectionCard({
  section,
  className,
  unfolded = false,
}: {
  section: IndexedSection;
  className?: string;
  /** The member asked for this folded section by name or by link. */
  unfolded?: boolean;
}) {
  const hash = useLocation({ select: (location) => location.hash });
  const [open, setOpen] = useState(
    !section.collapsed || normalizedHash(hash) === section.id,
  );
  useEffect(() => {
    if (normalizedHash(hash) === section.id) setOpen(true);
  }, [hash, section.id]);
  const [reportedCount, setCount] = useState<number | undefined>(undefined);
  const [reportedEmpty, setEmpty] = useState(false);
  const register = useContext(SectionIndexRegistryContext);
  const continuous = useContext(ContinuousDetailContext);
  const count = section.count ?? reportedCount ?? section.knownCount;
  const empty =
    section.empty === true ||
    reportedEmpty ||
    section.knownEmpty === true ||
    count === 0 ||
    section.content == null;
  const folded = !unfolded && section.foldWhenEmpty === true && empty;
  useEffect(() => {
    register?.(section.id, { empty, count });
    return () => register?.(section.id, undefined);
  }, [register, section.id, empty, count]);
  const heading: ComponentProps<typeof Section> = section.bare
    ? {}
    : {
        headingAs: section.headingAs ?? (continuous ? "h3" : "h2"),
        title: section.title,
      };
  // A proven-empty relation mounts nothing: no skeleton and no later collapse.
  // A section that reported empty itself stays mounted so it can report again.
  if ((folded && section.knownEmpty) || (section.countPending && !unfolded))
    return <span id={section.id} tabIndex={-1} hidden data-detail-section />;
  return (
    <SectionEmptyContext.Provider value={setEmpty}>
      <SectionCountContext.Provider value={setCount}>
        <Section
          id={section.id}
          tabIndex={-1}
          onFocus={(event) => {
            if (section.collapsed && event.target === event.currentTarget)
              setOpen(true);
          }}
          data-empty={empty || undefined}
          data-detail-section
          hidden={folded}
          className={cn(
            "scroll-mt-[calc(var(--app-chrome-top)+3rem)] focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            section.overflowVisible
              ? "overflow-visible"
              : "[contain-intrinsic-size:auto_320px] [content-visibility:auto]",
            className,
          )}
          aria-label={section.bare ? section.title : undefined}
          {...heading}
          disclosure={
            section.collapsed ? { open, onOpenChange: setOpen } : undefined
          }
          empty={empty}
          count={
            section.bare ? undefined : (
              <SectionIndexMarker
                id={`${section.id}-marker`}
                state={{ empty, count }}
              />
            )
          }
          caption={section.description}
          actions={section.headerAction}
        >
          {section.content ?? <EmptyState size="inline">No items.</EmptyState>}
        </Section>
      </SectionCountContext.Provider>
    </SectionEmptyContext.Provider>
  );
}

/** Sections in order, each declared pair sharing a row. */
export function SectionStack({
  sections,
  unfolded,
}: {
  sections: IndexedSection[];
  unfolded?: ReadonlySet<string>;
}) {
  const partners = new Set(sections.map((section) => section.pairWith));
  const card = (section: IndexedSection) => (
    <SectionCard
      key={section.id}
      section={section}
      unfolded={unfolded?.has(section.id)}
    />
  );
  return sections.flatMap((section) => {
    if (partners.has(section.id)) return [];
    const partner = sections.find(
      (candidate) => candidate.id === section.pairWith,
    );
    return partner ? (
      <SectionPair key={section.id}>
        {card(section)}
        {card(partner)}
      </SectionPair>
    ) : (
      card(section)
    );
  });
}

/**
 * Known-empty sections read as one quiet line at the end of their group. A
 * name unfolds its section, which keeps the section's own Add and Open all.
 */
function FoldedSectionsLine({
  sections,
  pending,
  onUnfold,
}: {
  sections: IndexedSection[];
  pending: number;
  onUnfold: (id: string) => void;
}) {
  if (sections.length === 0 && pending === 0) return null;
  return (
    <p
      data-folded-sections
      className="flex min-h-(--fact-row-height) flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"
    >
      {pending > 0 ? (
        <output>Checking {formatCount(pending)} more…</output>
      ) : null}
      {sections.length > 0 ? <span>Nothing recorded:</span> : null}
      {sections.map((section, index) => (
        <span key={section.id} className="inline-flex items-center gap-x-1.5">
          <button
            type="button"
            aria-label={`Show ${section.title}, nothing recorded`}
            onClick={() => onUnfold(section.id)}
            className="rounded-sm outline-none hover:text-foreground-strong hover:underline focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
          >
            {section.title}
          </button>
          {index < sections.length - 1 ? <span aria-hidden>·</span> : null}
        </span>
      ))}
    </p>
  );
}

function hashForDetailTarget(id: string, groups: IndexedSectionGroup[]) {
  const alias = id.replace("detail-group-", "");
  // A lead entry is a group whose id is its own anchor (e.g. facts `overview`).
  return groups.some(
    (group) =>
      (group.id === alias && group.id !== id) ||
      group.sections.some((section) => section.id === alias),
  )
    ? id
    : alias;
}

const currentDetailAnchorClass =
  "bg-row-current font-medium text-foreground-strong hover:bg-row-current";

/** A list section shows its row count, 0 included; an empty non-list section
 * is marked only for assistive tech, since its muted title already says so. */
function SectionIndexMarker({
  id,
  state,
  className,
}: {
  id?: string;
  state: SectionIndexState | undefined;
  className?: string;
}) {
  if (state?.count !== undefined)
    return (
      <span
        id={id}
        className={cn("shrink-0 text-muted-foreground tabular-nums", className)}
      >
        {formatCount(state.count)}
      </span>
    );
  return state?.empty ? (
    <span id={id} className="sr-only">
      Empty
    </span>
  ) : null;
}

function SectionIndex({
  groups,
  sectionStates,
  activeId,
  onSelect,
  onFocusTarget,
}: {
  groups: IndexedSectionGroup[];
  sectionStates: ReadonlyMap<string, SectionIndexState>;
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onFocusTarget: (id: string) => void;
}) {
  const navigationRef = useRef<HTMLElement>(null);
  const menuTargetRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const nav = navigationRef.current;
    const active = nav?.querySelector<HTMLElement>(
      'a[aria-current="location"]',
    );
    // A hidden nav measures all zeroes, so narrow layouts never scroll it.
    if (!nav || !active) return;
    const viewport = nav.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.top < viewport.top) nav.scrollTop += item.top - viewport.top;
    else if (item.bottom > viewport.bottom)
      nav.scrollTop += item.bottom - viewport.bottom;
  }, [activeId]);
  const selectMenuTarget = (id: string) => {
    menuTargetRef.current = document.getElementById(id);
    onSelect(id);
  };
  const activeTitle =
    groups
      .flatMap((group) => [group, ...group.sections])
      .find((entry) => entry.id === activeId)?.title ?? groups[0]?.title;
  const describedBy = (id: string) => {
    const state = sectionStates.get(id);
    return state?.count !== undefined || state?.empty
      ? `${id}-marker`
      : undefined;
  };
  const entryState = (id: string) => ({
    "aria-current": activeId === id ? ("location" as const) : undefined,
  });
  return (
    <div className="sticky top-[calc(var(--app-chrome-top)+var(--record-title-height,0px))] z-30 self-start bg-card @min-[800px]/record:w-52 @min-[800px]/record:shrink-0 @min-[800px]/record:bg-transparent">
      <nav
        ref={navigationRef}
        aria-label="Section index"
        className="hidden max-h-[calc(100dvh-var(--app-chrome-top)-var(--record-title-height,0px)-1rem)] overflow-y-auto overscroll-contain py-1 @min-[800px]/record:block"
      >
        {groups.map((group) => (
          <div key={group.id} className="mb-1.5 last:mb-0">
            <a
              href={`#${hashForDetailTarget(group.id, groups)}`}
              {...entryState(group.id)}
              className={cn(
                "relative flex h-(--nav-row-height) items-center rounded-lg px-2 text-xs font-semibold text-foreground-strong hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                activeId === group.id && currentDetailAnchorClass,
              )}
              onClick={(event) => {
                event.preventDefault();
                onSelect(group.id);
              }}
            >
              {group.title}
            </a>
            {/* Sections hang off their group on a hairline guide. */}
            <ul className="ml-3.5 border-l border-border pl-1.5 empty:hidden">
              {group.sections
                .filter((section) => section.includeInIndex !== false)
                .map((section) => {
                  const state = sectionStates.get(section.id);
                  return (
                    <li key={section.id}>
                      <a
                        href={`#${section.id}`}
                        {...entryState(section.id)}
                        aria-label={section.title}
                        aria-describedby={describedBy(section.id)}
                        title={section.title}
                        className={cn(
                          "relative flex h-(--nav-row-height) items-center gap-2 rounded-lg px-1.5 text-sm hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                          state?.empty
                            ? "text-muted-foreground/70"
                            : "text-foreground",
                          activeId === section.id && currentDetailAnchorClass,
                        )}
                        onClick={(event) => {
                          event.preventDefault();
                          onSelect(section.id);
                        }}
                      >
                        {section.indexLeading != null ? (
                          <span className="shrink-0">
                            {section.indexLeading}
                          </span>
                        ) : (
                          <section.icon
                            aria-hidden
                            className={cn(
                              "size-3.5 shrink-0",
                              state?.empty
                                ? "text-muted-foreground/50"
                                : "text-muted-foreground",
                            )}
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {section.title}
                        </span>
                        {state?.count !== undefined && (
                          <span
                            aria-hidden
                            className="shrink-0 font-mono text-xs font-normal text-muted-foreground/80 tabular-nums"
                          >
                            {formatCount(state.count)}
                          </span>
                        )}
                      </a>
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="@min-[800px]/record:hidden">
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
            // Final focus keeps the selected section in view after the menu closes
            // without adding a second history entry.
            finalFocus={() => {
              const target = menuTargetRef.current;
              if (!target) return true;
              onFocusTarget(target.id);
              return false;
            }}
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
                        <a
                          href={`#${section.id}`}
                          aria-label={section.title}
                          aria-describedby={describedBy(section.id)}
                        />
                      }
                      {...entryState(section.id)}
                      className={cn(
                        sectionStates.get(section.id)?.empty &&
                          "text-muted-foreground",
                      )}
                      onClick={(event) => {
                        event.preventDefault();
                        selectMenuTarget(section.id);
                      }}
                    >
                      {section.indexLeading != null ? (
                        <span className="shrink-0">{section.indexLeading}</span>
                      ) : null}
                      <span
                        className="min-w-0 flex-1 truncate"
                        title={section.title}
                      >
                        {section.title}
                      </span>
                      {sectionStates.get(section.id)?.count !== undefined && (
                        <span
                          aria-hidden
                          className="text-xs text-muted-foreground tabular-nums"
                        >
                          {formatCount(
                            sectionStates.get(section.id)?.count ?? 0,
                          )}
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))}
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/**
 * The section the reading line is in. Paired sections share a top, so document
 * order alone would always report the right-hand one: of those sharing the
 * lowest top above the line, prefer the first still running past it.
 */
function currentAtLine(targets: readonly HTMLElement[], line: number) {
  const above = targets
    .map((target) => ({ target, rect: target.getBoundingClientRect() }))
    .filter(({ rect }) => rect.top <= line);
  const lowest = Math.max(...above.map(({ rect }) => rect.top));
  const sharing = above.filter(({ rect }) => lowest - rect.top <= 1);
  return (
    sharing.find(({ rect }) => rect.bottom > line)?.target ?? sharing[0]?.target
  );
}

/**
 * One continuous, mounted page of grouped sections with a sticky contents
 * index on a wide surface (a "Jump to" menu below 800px), scroll-tracked
 * current entry, and URL fragments that keep Back/Forward. Record details and
 * the design showcase both render through it.
 */
export function IndexedSections({
  groups,
  footer,
  lead,
  leadIndex = [],
}: {
  groups: IndexedSectionGroup[];
  /** Rendered after the last group, outside the index. */
  footer?: ReactNode;
  /** Leads the center column, above the first group (Needs you, Activity). */
  lead?: ReactNode;
  /** Top-level index entries for blocks inside `lead`. Each target carries the
   * id, `data-detail-group` and `tabIndex={-1}` so jumps focus it. */
  leadIndex?: ReadonlyArray<{ id: string; title: string }>;
}) {
  const hydrated = useHydrated();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [sectionStates, setSectionStates] = useState<
    Map<string, SectionIndexState>
  >(new Map());
  const registerSection = useCallback(
    (id: string, state: SectionIndexState | undefined) => {
      setSectionStates((previous) => {
        const prior = previous.get(id);
        if (prior?.empty === state?.empty && prior?.count === state?.count)
          return previous;
        const next = new Map(previous);
        if (state) next.set(id, state);
        else next.delete(id);
        return next;
      });
    },
    [],
  );
  // Sections the member unfolded, or that a link named, this visit.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const unfold = useCallback((id: string) => {
    setUnfolded((previous) =>
      previous.has(id) ? previous : new Set([...previous, id]),
    );
  }, []);
  const isFolded = (section: IndexedSection) =>
    !unfolded.has(section.id) &&
    sectionIsFolded(section, sectionStates.get(section.id));
  const isPending = (section: IndexedSection) =>
    section.countPending === true && !unfolded.has(section.id);
  // The index lists what the page shows: a folded section is reachable from its
  // group's line, and a group of nothing but folded sections leaves the index.
  const populatedGroups = groups.flatMap((group) => {
    const sections = group.sections.filter(
      (section) => !isFolded(section) && !isPending(section),
    );
    return sections.length > 0 || group.sections.length === 0
      ? [{ ...group, sections }]
      : [];
  });
  const indexGroups = [
    ...leadIndex.map((entry) => ({ ...entry, sections: [] })),
    ...populatedGroups,
  ];
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
  const pendingFocus = useRef<string | undefined>(undefined);
  const focusTarget = useCallback(
    (id: string) => {
      const target = document.getElementById(id);
      if (!target || !workspaceRef.current?.contains(target)) return;
      // A link to a folded section unfolds it, then focuses it once it renders.
      if (target.hidden) {
        pendingFocus.current = id;
        unfold(id);
        return;
      }
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
    },
    [unfold],
  );
  useEffect(() => {
    const id = pendingFocus.current;
    if (id === undefined || !unfolded.has(id)) return;
    pendingFocus.current = undefined;
    focusTarget(id);
  }, [unfolded, focusTarget]);
  const selectSection = (id: string) => {
    focusTarget(id);
    void navigate({
      to: ".",
      search: true,
      hash: hashForDetailTarget(id, indexGroups),
      replace: false,
      resetScroll: false,
      hashScrollIntoView: false,
    });
  };
  // A fragment selects a location, never a hidden view. Back/forward and repeated
  // links preserve mounted editors; invalid fragments leave the page readable.
  useEffect(() => {
    if (hydrated && locationHash) focusTarget(targetForHash(locationHash));
  }, [hydrated, locationHash, targetForHash, focusTarget]);
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
      ).filter((target) => !target.hidden);
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
          : (currentAtLine(targets, top + 1) ?? targets[0]);
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
  return (
    <div ref={workspaceRef} className="@container/record min-w-0">
      <div className="space-y-3 @min-[800px]/record:flex @min-[800px]/record:items-start @min-[800px]/record:gap-6 @min-[800px]/record:space-y-0">
        <ContinuousDetailContext.Provider value>
          <SectionIndexRegistryContext.Provider value={registerSection}>
            <SectionIndex
              groups={indexGroups}
              sectionStates={sectionStates}
              activeId={activeId}
              onSelect={selectSection}
              onFocusTarget={focusTarget}
            />
            <div
              ref={bodyRef}
              className="min-w-0 flex-1 space-y-(--section-gap) text-sm"
            >
              {lead}
              {groups.map((group) => (
                <div
                  key={group.id}
                  id={group.id}
                  data-detail-group
                  tabIndex={-1}
                  className="scroll-mt-[calc(var(--app-chrome-top)+3rem)] space-y-2 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <h2 className="text-xs font-medium text-muted-foreground">
                    {group.title}
                  </h2>
                  <div className="space-y-(--section-gap)">
                    <SectionStack
                      sections={group.sections}
                      unfolded={unfolded}
                    />
                    <FoldedSectionsLine
                      sections={group.sections.filter(isFolded)}
                      pending={group.sections.filter(isPending).length}
                      onUnfold={unfold}
                    />
                  </div>
                </div>
              ))}
              {footer}
            </div>
          </SectionIndexRegistryContext.Provider>
        </ContinuousDetailContext.Provider>
      </div>
    </div>
  );
}
