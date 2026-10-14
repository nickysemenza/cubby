import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  type ElementType,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cn, formatCount } from "~/lib/utils";
import { useHydrated } from "~/ui/hooks/useHydrated";
import { SectionHeading } from "~/ui/layout";
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

function SectionCard({
  section,
  className,
}: {
  section: IndexedSection;
  className?: string;
}) {
  const [reportedCount, setCount] = useState<number | undefined>(undefined);
  const [reportedEmpty, setEmpty] = useState(false);
  const register = useContext(SectionIndexRegistryContext);
  const continuous = useContext(ContinuousDetailContext);
  const count = section.count ?? reportedCount;
  const empty =
    section.empty === true ||
    reportedEmpty ||
    count === 0 ||
    section.content == null;
  useEffect(() => {
    register?.(section.id, { empty, count });
    return () => register?.(section.id, undefined);
  }, [register, section.id, empty, count]);
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
            section.overflowVisible
              ? "overflow-visible"
              : "[contain-intrinsic-size:auto_320px] [content-visibility:auto]",
            className,
          )}
        >
          <SectionHeading
            as={Heading}
            id={`${section.id}-heading`}
            muted={empty}
            title={
              <>
                <section.icon className="size-3.5 shrink-0 text-muted-foreground" />
                {section.title}
              </>
            }
            meta={
              <SectionIndexMarker
                id={`${section.id}-marker`}
                state={{ empty, count }}
                className="text-xs font-normal"
              />
            }
            description={section.description}
            actions={section.headerAction}
          />
          <div className="mt-1.5 min-w-0 px-2">
            {section.content ?? (
              <p className="text-sm text-muted-foreground">No items.</p>
            )}
          </div>
        </section>
      </SectionCountContext.Provider>
    </SectionEmptyContext.Provider>
  );
}

/** Sections stacked without an index, for a single-workspace surface. */
export function SectionStack({ sections }: { sections: IndexedSection[] }) {
  return sections.map((section) => (
    <SectionCard key={section.id} section={section} />
  ));
}

function hashForDetailTarget(id: string, groups: IndexedSectionGroup[]) {
  const alias = id.replace("detail-group-", "");
  return groups.some((group) =>
    group.sections.some((section) => section.id === alias),
  )
    ? id
    : alias;
}

const currentDetailAnchorClass =
  "font-medium text-foreground before:absolute before:inset-y-1.5 before:start-0.5 before:w-0.5 before:rounded-full before:bg-foreground";

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
  wide,
  onSelect,
  onFocusTarget,
}: {
  groups: IndexedSectionGroup[];
  sectionStates: ReadonlyMap<string, SectionIndexState>;
  activeId: string | undefined;
  wide: boolean;
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
    <div
      className={cn(
        "sticky top-[var(--app-chrome-top)] z-30 self-start",
        wide ? "w-40 shrink-0" : "bg-card",
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
                "relative block rounded-md px-2 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                activeId === group.id && currentDetailAnchorClass,
              )}
              onClick={(event) => {
                event.preventDefault();
                onSelect(group.id);
              }}
            >
              {group.title}
            </a>
            <ul>
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
                          "relative flex h-7 items-center gap-2 rounded-md pr-2 pl-3 hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                          state?.empty
                            ? "text-muted-foreground"
                            : "text-foreground",
                          activeId === section.id && currentDetailAnchorClass,
                        )}
                        onClick={(event) => {
                          event.preventDefault();
                          onSelect(section.id);
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {section.title}
                        </span>
                        {state?.count !== undefined && (
                          <span
                            aria-hidden
                            className="shrink-0 text-[11px] font-normal text-muted-foreground tabular-nums"
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
      )}
    </div>
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
}: {
  groups: IndexedSectionGroup[];
  /** Rendered after the last group, outside the index. */
  footer?: ReactNode;
}) {
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
  return (
    <div
      ref={workspaceRef}
      className={cn("min-w-0", wide ? "flex items-start gap-4" : "space-y-2")}
    >
      <ContinuousDetailContext.Provider value>
        <SectionIndexRegistryContext.Provider value={registerSection}>
          <SectionIndex
            groups={groups}
            sectionStates={sectionStates}
            activeId={activeId}
            wide={wide}
            onSelect={selectSection}
            onFocusTarget={focusTarget}
          />
          <div
            ref={bodyRef}
            className="min-w-0 flex-1 space-y-4 text-[0.8125rem]/5"
          >
            {groups.map((group) => (
              <div
                key={group.id}
                id={group.id}
                data-detail-group
                tabIndex={-1}
                className="scroll-mt-[calc(var(--app-chrome-top)+3rem)] space-y-2 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <h2 className="text-sm font-semibold">{group.title}</h2>
                <div className="space-y-3">
                  <SectionStack sections={group.sections} />
                </div>
              </div>
            ))}
            {footer}
          </div>
        </SectionIndexRegistryContext.Provider>
      </ContinuousDetailContext.Provider>
    </div>
  );
}
