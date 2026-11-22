import { cn } from "cn";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { formatCount } from "~/lib/number-format";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Kbd } from "~/ui/primitives/kbd";

import {
  ContinuousDetailContext,
  SectionIndexRegistryContext,
  type SectionIndexState,
} from "./detail-section-state";
import {
  FoldedSectionsLine,
  hashForDetailTarget,
  type IndexedSection,
  type IndexedSectionGroup,
  type RecordSectionControls,
  RecordSectionControlsContext,
  SectionJumpMenu,
  SectionStack,
  useIndexedSections,
} from "./indexed-sections";

import "./record-workspace.css";

const FINE_DESKTOP =
  "(min-width: 48rem) and (hover: hover) and (pointer: fine)";
/** Pane widths (px) where the rail appears and the body takes two columns. */
const RAIL_WIDTH = 800;
const COLUMNS_WIDTH = 1000;

const ROWS =
  '[data-slot="table-row"]:not(thead *), [data-slot="record-row"], [data-row-cursor-target]';

const isEditableTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest(
      "input, textarea, select, [contenteditable=''], [contenteditable=true], [role=combobox], [role=listbox], [role=menu], [role=dialog], [role=alertdialog]",
    ) !== null);

/** Whether the pane draws the rail, and whether its body has two columns. */
function usePaneMode(workspace: RefObject<HTMLElement | null>) {
  const [mode, setMode] = useState({ rail: false, columns: false });
  useEffect(() => {
    const element = workspace.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const media = window.matchMedia?.(FINE_DESKTOP);
    const update = () => {
      const desktop =
        (media?.matches ?? true) &&
        !document.documentElement.hasAttribute("data-hosted-workspace");
      const width = element.getBoundingClientRect().width;
      const next = {
        rail: desktop && width >= RAIL_WIDTH,
        columns: desktop && width >= COLUMNS_WIDTH,
      };
      setMode((previous) =>
        previous.rail === next.rail && previous.columns === next.columns
          ? previous
          : next,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    media?.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", update);
    };
  }, [workspace]);
  return mode;
}

/**
 * Whether Activity is too short to hold a column of its own. A short Activity
 * joins the body's columns, so no empty column runs beside a long body; it
 * returns to its column once it outgrows the threshold. Loading never decides.
 */
function useShortActivity(
  workspace: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const [short, setShort] = useState(false);
  useEffect(() => {
    const root = workspace.current;
    if (!enabled || !root || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const decide = () => {
      const section = root.querySelector<HTMLElement>("[data-record-activity]");
      if (!section || section.querySelector('[data-slot="skeleton"]')) return;
      const height = section.getBoundingClientRect().height;
      const body = root.querySelector(".record-body");
      const tall =
        (body?.getBoundingClientRect().height ?? 0) > window.innerHeight;
      setShort((previous) =>
        previous
          ? height < window.innerHeight * 0.6
          : tall && height < window.innerHeight * 0.4,
      );
    };
    // Settle before deciding: a section that is still filling must not move.
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(decide, 400);
    });
    const target = root.querySelector(".record-main-grid");
    if (target) observer.observe(target);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [workspace, enabled]);
  return enabled && short;
}

/** The ids of the sections some part of which is on screen. */
function useOnScreen(
  workspace: RefObject<HTMLElement | null>,
  enabled: boolean,
  signature: string,
) {
  const [visible, setVisible] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const element = workspace.current;
    if (!enabled || !element || typeof IntersectionObserver === "undefined")
      return;
    const seen = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) seen.add(entry.target.id);
        else seen.delete(entry.target.id);
      }
      setVisible(new Set(seen));
    });
    for (const target of element.querySelectorAll<HTMLElement>(
      ".record-main [data-detail-section]",
    ))
      if (!target.hidden) observer.observe(target);
    return () => observer.disconnect();
  }, [workspace, enabled, signature]);
  return visible;
}

/**
 * The rail's contents index: each group's sections in two columns, with a
 * mark on the ones on screen, a dot on the ones that need the member, and
 * their counts.
 */
function RailIndex({
  groups,
  sectionStates,
  activeId,
  onScreen,
  attention,
  onSelect,
}: {
  groups: IndexedSectionGroup[];
  sectionStates: ReadonlyMap<string, SectionIndexState>;
  activeId: string | undefined;
  onScreen: ReadonlySet<string>;
  attention: ReadonlySet<string>;
  onSelect: (id: string) => void;
}) {
  return (
    <nav aria-label="Section index" className="record-index text-xs">
      <p className="mb-0.5 flex items-center justify-between text-muted-foreground">
        <span>Contents</span>
        <span aria-hidden className="inline-flex items-center gap-1">
          <span className="h-2.5 w-0.5 bg-foreground" />
          on screen
        </span>
      </p>
      {groups.map((group) => {
        const sections = group.sections.filter(
          (section) => section.includeInIndex !== false,
        );
        if (sections.length === 0) return null;
        return (
          <div
            key={group.id}
            className="grid grid-cols-[3.25rem_minmax(0,1fr)] items-start"
          >
            <a
              href={`#${hashForDetailTarget(group.id, groups)}`}
              className="flex h-4.5 items-center truncate rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.preventDefault();
                onSelect(group.id);
              }}
            >
              {group.title}
            </a>
            <ul className="grid min-w-0 grid-cols-2 gap-x-2">
              {sections.map((section) => {
                const state = sectionStates.get(section.id);
                const current = activeId === section.id;
                return (
                  <li key={section.id} className="min-w-0">
                    <a
                      href={`#${section.id}`}
                      aria-current={current ? "location" : undefined}
                      aria-label={section.title}
                      aria-describedby={
                        state?.count !== undefined || state?.empty
                          ? `${section.id}-marker`
                          : undefined
                      }
                      title={section.title}
                      data-on-screen={onScreen.has(section.id) || undefined}
                      className={cn(
                        "flex h-4.5 min-w-0 items-center gap-1 border-l-2 border-transparent pr-0.5 pl-1 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-on-screen:border-foreground",
                        state?.empty
                          ? "text-muted-foreground/70"
                          : "text-foreground",
                        current && "bg-row-current font-medium",
                      )}
                      onClick={(event) => {
                        event.preventDefault();
                        onSelect(section.id);
                      }}
                    >
                      <span className="min-w-0 truncate">{section.title}</span>
                      {attention.has(section.id) ? (
                        <span className="size-1.5 shrink-0 rounded-full bg-needs">
                          <span className="sr-only">Needs you</span>
                        </span>
                      ) : null}
                      {state?.count !== undefined ? (
                        <span
                          aria-hidden
                          className="ml-auto shrink-0 pl-1 font-mono text-muted-foreground tabular-nums"
                        >
                          {formatCount(state.count)}
                        </span>
                      ) : null}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

interface Cursor {
  section: string;
  label: string;
  index: number;
  total: number;
}

/**
 * The record page's keys: J/K move a row cursor through the body's rows, Enter
 * opens the row, H/L fold and unfold its section, W widens it, E edits the
 * record, 1-9 reach the Needs you items and [ ] step to the neighbouring record. A key that belongs
 * to a field, a menu or a dialog is left alone.
 */
function useRecordKeys(
  workspace: RefObject<HTMLElement | null>,
  enabled: boolean,
  controls: RecordSectionControls,
  activeId: string | undefined,
) {
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const row = useRef<HTMLElement | null>(null);
  // The section the cursor last sat in: H folds it away, and L needs it back.
  const lastSection = useRef<string | undefined>(undefined);
  const latest = useRef({ controls, activeId });
  latest.current = { controls, activeId };
  useEffect(() => {
    const root = workspace.current;
    if (!enabled || !root) return;
    const rows = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          ".record-main [data-detail-section]",
        ),
      )
        .filter((section) => !section.hidden && !section.dataset.folded)
        .flatMap((section) =>
          Array.from(section.querySelectorAll<HTMLElement>(ROWS)),
        )
        .filter((candidate) => candidate.getClientRects().length > 0);
    const place = (next: HTMLElement | null, all: HTMLElement[]) => {
      row.current?.removeAttribute("data-row-cursor");
      row.current = next;
      if (!next) return setCursor(null);
      next.setAttribute("data-row-cursor", "");
      next.scrollIntoView({ block: "nearest" });
      const section = next.closest<HTMLElement>("[data-detail-section]");
      lastSection.current = section?.id;
      const peers = all.filter(
        (candidate) => candidate.closest("[data-detail-section]") === section,
      );
      setCursor({
        section: section?.dataset.sectionTitle ?? "",
        label: (next.querySelector("a")?.textContent ?? next.textContent ?? "")
          .trim()
          .slice(0, 80),
        index: peers.indexOf(next) + 1,
        total: peers.length,
      });
    };
    const currentSection = () => {
      const id =
        row.current?.closest<HTMLElement>("[data-detail-section]")?.id ??
        lastSection.current ??
        latest.current.activeId;
      const target = id
        ? root.querySelector<HTMLElement>(`.record-main #${CSS.escape(id)}`)
        : null;
      // The current index entry may be a group: act on its first section.
      const section = target?.matches("[data-detail-section]")
        ? target
        : target?.querySelector<HTMLElement>(
            "[data-detail-section]:not([hidden])",
          );
      lastSection.current = section?.id;
      return section?.id;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target) ||
        // A modal on top owns its keys; a docked, non-modal panel does not.
        document.querySelector('[aria-modal="true"], [role=alertdialog]')
      )
        return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const handled = (() => {
        if (key === "j" || key === "k") {
          const all = rows();
          if (all.length === 0) return false;
          const at = row.current ? all.indexOf(row.current) : -1;
          const top = all.findIndex(
            (candidate) => candidate.getBoundingClientRect().top >= 0,
          );
          const next =
            at === -1
              ? Math.max(top, 0)
              : Math.min(
                  Math.max(at + (key === "j" ? 1 : -1), 0),
                  all.length - 1,
                );
          place(all[next] ?? null, all);
          return true;
        }
        if (key === "Escape" && row.current) {
          place(null, []);
          return true;
        }
        if (key === "Enter" && row.current) {
          const target =
            row.current.querySelector<HTMLElement>("a[href], button") ??
            row.current;
          target.click();
          return true;
        }
        if (key === "h" || key === "l") {
          const id = currentSection();
          if (!id || !root.querySelector(`.record-main #${CSS.escape(id)}`))
            return false;
          const folded = latest.current.controls.folded.has(id);
          if (folded === (key === "h")) return true;
          if (key === "h") place(null, []);
          latest.current.controls.toggleFold(id);
          return true;
        }
        if (key === "w") {
          const id = currentSection();
          const section = id
            ? root.querySelector<HTMLElement>(`.record-main #${CSS.escape(id)}`)
            : null;
          const toggle = section?.querySelector<HTMLElement>(
            "[data-slot=section-heading] button[aria-pressed]",
          );
          if (!toggle) return false;
          toggle.click();
          return true;
        }
        if (/^[1-9]$/u.test(key)) {
          const item =
            root.querySelectorAll<HTMLElement>("[data-needs-item]")[
              Number(key) - 1
            ];
          if (!item) return false;
          (item.querySelector<HTMLElement>("a, button") ?? item).focus();
          return true;
        }
        if (key === "e") {
          const edit = root.querySelector<HTMLElement>(
            '[data-record-commands] [aria-keyshortcuts="E"]',
          );
          if (!edit) return false;
          edit.click();
          return true;
        }
        if (key === "[" || key === "]") {
          const steps = root.querySelectorAll<HTMLButtonElement>(
            "[data-record-stepper] button",
          );
          const step = key === "[" ? steps[0] : steps[steps.length - 1];
          if (!step || step.disabled) return false;
          step.click();
          return true;
        }
        return false;
      })();
      if (handled) event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      row.current?.removeAttribute("data-row-cursor");
      row.current = null;
    };
  }, [workspace, enabled]);
  return cursor;
}

const Key = ({ children }: { children: ReactNode }) => (
  <Kbd className="h-auto min-w-0 bg-transparent px-0 font-mono font-semibold text-foreground">
    {children}
  </Kbd>
);

/** The page's key legend, led by where the row cursor is. */
function HintLine({
  cursor,
  current,
  columns,
  needs,
  stepper,
}: {
  cursor: Cursor | null;
  current: string | undefined;
  columns: boolean;
  needs: boolean;
  stepper: boolean;
}) {
  return (
    <div
      data-record-hints
      className="record-hints text-xs text-muted-foreground"
    >
      <span aria-live="polite" className="min-w-0 flex-1 truncate">
        {cursor ? (
          <>
            {cursor.section} <span aria-hidden>›</span>{" "}
            <span className="text-foreground">{cursor.label}</span>{" "}
            <span className="font-mono tabular-nums">
              row {cursor.index}/{cursor.total}
            </span>
          </>
        ) : (
          current
        )}
      </span>
      <span aria-hidden className="flex shrink-0 items-center gap-3">
        <span>
          <Key>J</Key> <Key>K</Key> row
        </span>
        <span>
          <Key>H</Key> <Key>L</Key> fold
        </span>
        {columns ? (
          <span>
            <Key>W</Key> wide
          </span>
        ) : null}
        <span>
          <Key>↵</Key> open
        </span>
        <span>
          <Key>E</Key> edit
        </span>
        {needs ? (
          <span>
            <Key>1-9</Key> needs you
          </span>
        ) : null}
        {stepper ? (
          <span>
            <Key>[</Key> <Key>]</Key> record
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * A record's page: singular facts in a sticky left rail over its contents
 * index, signals pinned above a column body of the record's collections, and
 * Activity in its own column on a wide pane. Phones, coarse pointers and hosted
 * native workspaces read the same parts as one stack.
 */
export function RecordWorkspace({
  groups,
  activityId,
  rail,
  signals,
  attention,
  footer,
}: {
  groups: IndexedSectionGroup[];
  /** The section drawn as the Activity column on a wide pane. */
  activityId?: string;
  /** Identity, commands and every singular fact. */
  rail: ReactNode;
  /** Needs you and the summary figures. */
  signals?: ReactNode;
  /** Sections with something waiting on the member. */
  attention?: ReadonlySet<string>;
  /** Rendered after the last section, outside the index. */
  footer?: ReactNode;
}) {
  const hydrated = useHydrated();
  const [folded, setFolded] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        groups.flatMap((group) =>
          group.sections
            .filter((section) => section.collapsed)
            .map((section) => section.id),
        ),
      ),
  );
  const [wide, setWide] = useState<ReadonlySet<string>>(new Set());
  const toggle =
    (set: typeof setFolded) =>
    (id: string): void =>
      set((previous) => {
        const next = new Set(previous);
        if (!next.delete(id)) next.add(id);
        return next;
      });
  // A link or fragment naming a folded section opens it.
  const reveal = useCallback((id: string) => {
    setFolded((previous) => {
      if (!previous.has(id)) return previous;
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  }, []);
  const {
    workspaceRef,
    bodyRef,
    sectionStates,
    registerSection,
    unfolded,
    unfold,
    isFolded,
    isPending,
    indexGroups,
    activeId,
    selectSection,
    focusTarget,
  } = useIndexedSections(groups, reveal);
  const mode = usePaneMode(workspaceRef);
  const controls = useMemo<RecordSectionControls>(
    () => ({
      folded,
      toggleFold: toggle(setFolded),
      wide,
      toggleWide: toggle(setWide),
      columns: mode.columns,
    }),
    [folded, wide, mode.columns],
  );
  const signalsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = signalsRef.current;
    const root = workspaceRef.current;
    if (!element || !root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      root.style.setProperty(
        "--record-signals-height",
        `${element.getBoundingClientRect().height}px`,
      ),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [workspaceRef]);
  const activity = groups
    .flatMap((group) => group.sections)
    .find((section) => section.id === activityId);
  const bodyGroups = groups.map((group) => ({
    ...group,
    sections: group.sections.filter((section) => section !== activity),
  }));
  const bodySections = bodyGroups.flatMap((group) => group.sections);
  const activityInBody = useShortActivity(workspaceRef, mode.columns);
  const onScreen = useOnScreen(
    workspaceRef,
    hydrated && mode.rail,
    indexGroups
      .flatMap((group) => group.sections.map((section) => section.id))
      .join(" "),
  );
  const cursor = useRecordKeys(workspaceRef, mode.rail, controls, activeId);
  // The legend names only the keys this record has targets for.
  const [targets, setTargets] = useState({ needs: false, stepper: false });
  const hasSignals = signals != null;
  useEffect(() => {
    const root = workspaceRef.current;
    if (!root || typeof MutationObserver === "undefined") return;
    const read = () => {
      const next = {
        needs: root.querySelector("[data-needs-item]") !== null,
        stepper: root.querySelector("[data-record-stepper]") !== null,
      };
      setTargets((previous) =>
        previous.needs === next.needs && previous.stepper === next.stepper
          ? previous
          : next,
      );
    };
    const signalsBar = root.querySelector(".record-signals");
    if (!signalsBar) {
      read();
      return;
    }
    const observer = new MutationObserver(read);
    observer.observe(signalsBar, { childList: true, subtree: true });
    read();
    return () => observer.disconnect();
  }, [workspaceRef, hasSignals]);
  const indexProps = {
    groups: indexGroups,
    sectionStates,
    activeId,
    onSelect: selectSection,
  };
  const currentTitle = indexGroups
    .flatMap((group) => [group, ...group.sections])
    .find((entry) => entry.id === activeId)?.title;
  const stack = (sections: IndexedSection[]) => (
    <SectionStack sections={sections} unfolded={unfolded} />
  );
  return (
    <div
      ref={workspaceRef}
      data-record-workspace
      className="@container/record min-w-0"
    >
      <ContinuousDetailContext.Provider value>
        <SectionIndexRegistryContext.Provider value={registerSection}>
          <RecordSectionControlsContext.Provider value={controls}>
            <div className="record-frame">
              <aside aria-label="Record" className="record-rail">
                <div data-record-rail-scroll className="record-rail-scroll">
                  {rail}
                </div>
                <RailIndex
                  {...indexProps}
                  onScreen={onScreen}
                  attention={attention ?? new Set()}
                />
              </aside>
              <div className="record-main">
                <div className="record-jump">
                  <SectionJumpMenu
                    {...indexProps}
                    onFocusTarget={focusTarget}
                  />
                </div>
                {signals != null ? (
                  <div ref={signalsRef} className="record-signals">
                    {signals}
                  </div>
                ) : null}
                <div
                  // Scroll tracking reads the sections of both columns.
                  ref={bodyRef}
                  className="record-main-grid"
                  data-activity={activity && !activityInBody ? "" : undefined}
                >
                  <div className="record-body text-sm">
                    {bodyGroups.map((group) => (
                      <GroupAnchor key={group.id} id={group.id}>
                        {stack(group.sections)}
                      </GroupAnchor>
                    ))}
                    {activity && activityInBody ? (
                      <div data-record-activity>{stack([activity])}</div>
                    ) : null}
                    <FoldedSectionsLine
                      sections={bodySections.filter(isFolded)}
                      pending={bodySections.filter(isPending).length}
                      onUnfold={unfold}
                    />
                    {footer}
                  </div>
                  {activity && !activityInBody ? (
                    <div
                      data-record-activity
                      className="record-activity text-sm"
                    >
                      {stack([activity])}
                    </div>
                  ) : null}
                </div>
                <HintLine
                  cursor={cursor}
                  current={currentTitle}
                  columns={mode.columns}
                  needs={targets.needs}
                  stepper={targets.stepper}
                />
              </div>
            </div>
          </RecordSectionControlsContext.Provider>
        </SectionIndexRegistryContext.Provider>
      </ContinuousDetailContext.Provider>
    </div>
  );
}

/** A group's fragment target around its sections; its label lives in the index. */
function GroupAnchor({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div
      id={id}
      data-detail-group
      tabIndex={-1}
      className="outline-none focus-visible:outline-2 focus-visible:outline-ring"
    >
      {children}
    </div>
  );
}
