import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { Kbd } from "~/ui/primitives/kbd";

import {
  ContinuousDetailContext,
  SectionIndexRegistryContext,
} from "./detail-section-state";
import {
  type IndexedSection,
  type IndexedSectionGroup,
  LedgerCard,
  type RecordSectionControls,
  RecordSectionControlsContext,
  SectionStack,
  useIndexedSections,
  useSectionOpenState,
} from "./indexed-sections";

const FINE_DESKTOP =
  "(min-width: 48rem) and (hover: hover) and (pointer: fine)";

const ROWS =
  '[data-slot="table-row"]:not(thead *), [data-slot="record-row"], [data-row-cursor-target]';

/** Sections whose rows J/K walk: open cards and opened ledger rows. */
const OPEN_SECTIONS = "[data-detail-section]:not([data-folded]):not([hidden])";

const isHosted = () =>
  typeof document !== "undefined" &&
  document.documentElement.hasAttribute("data-hosted-workspace");

const isEditableTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest(
      "input, textarea, select, [contenteditable=''], [contenteditable=true], [role=combobox], [role=listbox], [role=menu], [role=dialog], [role=alertdialog]",
    ) !== null);

/** A fine-pointer desktop outside a hosted native workspace: the page has keys. */
function useFineDesktop() {
  const [fine, setFine] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.(FINE_DESKTOP);
    const update = () => setFine((media?.matches ?? true) && !isHosted());
    media?.addEventListener("change", update);
    update();
    return () => media?.removeEventListener("change", update);
  }, []);
  return fine;
}

interface Cursor {
  section: string;
  label: string;
  index: number;
  total: number;
}

/**
 * The record page's keys: J/K move a row cursor through the open sections'
 * rows, Enter opens the row, H/L close and open the current section (a card or
 * a ledger row), E edits the record, 1-9 reach the Needs you items and [ ]
 * step to the neighbouring record. A key that belongs to a field, a menu or a
 * dialog is left alone; Enter on a focused ledger row is the row's own button.
 */
function useRecordKeys(
  workspace: RefObject<HTMLElement | null>,
  enabled: boolean,
  controls: RecordSectionControls,
  activeId: string | undefined,
) {
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const row = useRef<HTMLElement | null>(null);
  // The section the cursor last sat in: H closes it, and L needs it back.
  const lastSection = useRef<string | undefined>(undefined);
  const latest = useRef({ controls, activeId });
  latest.current = { controls, activeId };
  useEffect(() => {
    const root = workspace.current;
    if (!enabled || !root) return;
    const rows = () =>
      Array.from(root.querySelectorAll<HTMLElement>(OPEN_SECTIONS))
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
      const focused =
        document.activeElement instanceof HTMLElement &&
        root.contains(document.activeElement)
          ? document.activeElement.closest<HTMLElement>("[data-detail-section]")
          : null;
      const id =
        focused?.id ??
        row.current?.closest<HTMLElement>("[data-detail-section]")?.id ??
        lastSection.current ??
        latest.current.activeId;
      lastSection.current = id;
      return id && root.querySelector(`#${CSS.escape(id)}`) ? id : undefined;
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
          if (!id) return false;
          const open = key === "l";
          if (latest.current.controls.isOpen(id) === open) return true;
          if (!open) place(null, []);
          latest.current.controls.setOpen(id, open);
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
  needs,
  stepper,
}: {
  cursor: Cursor | null;
  current: string | undefined;
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
          <Key>H</Key> <Key>L</Key> close · open
        </span>
        <span>
          <Key>↵</Key> open row
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

/** The legend names only the keys this record has targets for. */
function useKeyTargets(workspace: RefObject<HTMLElement | null>) {
  const [targets, setTargets] = useState({ needs: false, stepper: false });
  useEffect(() => {
    const root = workspace.current;
    if (!root || typeof MutationObserver === "undefined") return;
    const side = root.querySelector(".record-side") ?? root;
    const read = () => {
      const next = {
        needs: side.querySelector("[data-needs-item]") !== null,
        stepper: side.querySelector("[data-record-stepper]") !== null,
      };
      setTargets((previous) =>
        previous.needs === next.needs && previous.stepper === next.stepper
          ? previous
          : next,
      );
    };
    const observer = new MutationObserver(read);
    observer.observe(side, { childList: true, subtree: true });
    read();
    return () => observer.disconnect();
  }, [workspace]);
  return targets;
}

/**
 * Activity's card: its latest entries, held to a few lines until the member
 * opens the whole timeline in place.
 */
function ActivityCard({
  section,
  expanded,
  onExpandedChange,
}: {
  section: IndexedSection;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const body = host.current?.querySelector<HTMLElement>(
      "[data-record-card] > div:last-child",
    );
    if (!body || typeof ResizeObserver === "undefined") return;
    const measure = () =>
      setOverflows(body.scrollHeight > body.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    for (const child of body.children) observer.observe(child);
    measure();
    return () => observer.disconnect();
  }, [expanded]);
  return (
    <div
      ref={host}
      data-record-activity
      data-expanded={expanded || undefined}
      className="record-activity"
    >
      <SectionStack
        card
        sections={[
          {
            ...section,
            headerAction:
              overflows || expanded ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => onExpandedChange(!expanded)}
                  className="rounded-sm text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
                >
                  {expanded ? "Latest only" : "All activity"}
                </button>
              ) : (
                section.headerAction
              ),
          },
        ]}
      />
    </div>
  );
}

/**
 * A record laid out as cards on the page canvas. The title bar runs across
 * the top; below it a main column holds the facts card, the open section cards
 * (the record's primary section and each section holding something for the
 * member) and one "More on this record" card of one-line ledger rows, beside a
 * sticky summary column of the summary, Needs you and Activity cards. Narrow
 * panes, phones, coarse pointers and the inspector read the same cards as one
 * stack. A hosted native workspace keeps every section open.
 */
export function RecordWorkspace({
  title,
  groups,
  activityId,
  facts,
  summary,
  checklist,
  attention,
  storageKey,
  variant = "page",
  footer,
}: {
  /** The title bar: breadcrumb, title, badges and commands. */
  title?: ReactNode;
  groups: IndexedSectionGroup[];
  /** The section drawn as the Activity card. */
  activityId?: string;
  /** Every singular fact. */
  facts?: ReactNode;
  /** The record's key figures and the step to its neighbours. */
  summary?: ReactNode;
  /** Needs you and the record's quality checks. */
  checklist?: ReactNode;
  /** Sections holding something for the member: they open as cards. */
  attention?: ReadonlySet<string>;
  /** Where the member's open and closed sections are remembered. */
  storageKey?: string;
  /** `inspector`: the side panel beside a list, one narrow stack without keys. */
  variant?: "page" | "inspector";
  /** Rendered after the last card. */
  footer?: ReactNode;
}) {
  const page = variant === "page";
  const [hosted] = useState(isHosted);
  const sections = groups.flatMap((group) => group.sections);
  const activity = sections.find((section) => section.id === activityId);
  const body = sections.filter((section) => section !== activity);
  const primary = groups[0]?.sections.find((section) => section !== activity);
  const cards = body.filter(
    (section) =>
      hosted || section === primary || attention?.has(section.id) === true,
  );
  const rows = body.filter((section) => !cards.includes(section));
  const rowIds = new Set(rows.map((section) => section.id));
  const collapsed = new Set(
    sections
      .filter((section) => section.collapsed)
      .map((section) => section.id),
  );
  // Ledger lines start closed; cards, Activity and sections nested inside a
  // section's body (embedded analytics) start open.
  const defaultOpen = (id: string) => !rowIds.has(id) && !collapsed.has(id);
  const fine = useFineDesktop();
  // Closed lines mount their bodies, hidden, only on a desktop page: a phone
  // would render every table's cards to report one line each.
  const { controls, reveal } = useSectionOpenState(
    hosted ? null : (storageKey ?? null),
    defaultOpen,
    page && fine,
  );
  const [activityExpanded, setActivityExpanded] = useState(false);
  // A link into a closed section, the folded facts or Activity's older
  // entries opens what holds it.
  const revealTarget = useCallback(
    (target: HTMLElement) => {
      const section = target.closest<HTMLElement>("[data-detail-section]");
      if (section) reveal(section.id);
      if (target.closest("[data-record-activity]")) setActivityExpanded(true);
      target
        .closest<HTMLElement>("[data-record-facts]")
        ?.dispatchEvent(new CustomEvent("record-facts-reveal"));
    },
    [reveal],
  );
  const {
    workspaceRef,
    bodyRef,
    registerSection,
    unfolded,
    unfold,
    isFolded,
    isPending,
    indexGroups,
    activeId,
  } = useIndexedSections(groups, revealTarget);
  const cursor = useRecordKeys(workspaceRef, page && fine, controls, activeId);
  const targets = useKeyTargets(workspaceRef);
  const currentTitle = indexGroups
    .flatMap((group) => [group, ...group.sections])
    .find((entry) => entry.id === activeId)?.title;
  const folded = body.filter(isFolded);
  return (
    <div
      ref={workspaceRef}
      data-record-workspace={variant}
      className="record-workspace @container/record"
    >
      <ContinuousDetailContext.Provider value>
        <SectionIndexRegistryContext.Provider value={registerSection}>
          <RecordSectionControlsContext.Provider value={controls}>
            {title != null ? <div className="record-title">{title}</div> : null}
            <div className="record-columns">
              <div className="record-side">
                {summary != null ? (
                  <div className="record-summary-slot">{summary}</div>
                ) : null}
                {checklist != null ? (
                  <div className="record-checklist-slot">{checklist}</div>
                ) : null}
                {activity ? (
                  <ActivityCard
                    section={activity}
                    expanded={activityExpanded}
                    onExpandedChange={setActivityExpanded}
                  />
                ) : null}
              </div>
              <div ref={bodyRef} className="record-main">
                {facts}
                <SectionStack card sections={cards} unfolded={unfolded} />
                <LedgerCard
                  title="More on this record"
                  caption={
                    page
                      ? "One line each. Open a line to see it in full."
                      : undefined
                  }
                  sections={rows}
                  folded={folded}
                  pending={body.filter(isPending).length}
                  unfolded={unfolded}
                  onUnfold={unfold}
                />
                {footer}
              </div>
            </div>
            {page ? (
              <HintLine
                cursor={cursor}
                current={currentTitle}
                needs={targets.needs}
                stepper={targets.stepper}
              />
            ) : null}
          </RecordSectionControlsContext.Provider>
        </SectionIndexRegistryContext.Provider>
      </ContinuousDetailContext.Provider>
    </div>
  );
}
