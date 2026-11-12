import { useLocation, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { formatCount } from "~/lib/number-format";
import { useHydrated } from "~/ui/hooks/use-hydrated";

import {
  SectionIndexRegistryContext,
  type SectionIndexState,
} from "./detail-section-state";
import {
  FoldedSectionsLine,
  type IndexedSection,
  normalizedHash,
  SectionStack,
  sectionIsFolded,
} from "./indexed-sections";

/** One tab: a declared section group and its sections in order. */
export interface DetailWorkspaceGroup {
  id: string;
  title: string;
  sections: IndexedSection[];
}

/** The tab a fragment names: a group, or the group holding that section. */
const groupFor = (groups: readonly DetailWorkspaceGroup[], id: string) =>
  groups.find((group) => group.id === id)?.id ??
  groups.find((group) => group.sections.some((section) => section.id === id))
    ?.id;

const panelId = (group: string) => `detail-group-${group}`;
const tabId = (group: string) => `detail-tab-${group}`;

/**
 * Inactive panels stay in the DOM as `hidden="until-found"`, so find-in-page
 * reaches their text and `beforematch` selects their tab. React only knows the
 * boolean `hidden`; the value is set here after each commit, and a browser
 * without `until-found` keeps plain `hidden`.
 */
function useUntilFound(
  container: React.RefObject<HTMLElement | null>,
  active: string,
  onMatch: (group: string) => void,
) {
  useLayoutEffect(() => {
    const panels = container.current?.querySelectorAll<HTMLElement>(
      "[data-detail-panel]",
    );
    if (!panels) return;
    const listeners: Array<() => void> = [];
    for (const panel of panels) {
      const group = panel.dataset.detailPanel ?? "";
      if (group !== active && "onbeforematch" in panel)
        panel.setAttribute("hidden", "until-found");
      const listener = () => onMatch(group);
      panel.addEventListener("beforematch", listener);
      listeners.push(() => panel.removeEventListener("beforematch", listener));
    }
    return () => {
      for (const remove of listeners) remove();
    };
  });
}

/**
 * The full record's workspace: a side column (Needs you, key facts, the kind
 * explanation) beside the declared section groups as tabs. Every panel stays
 * mounted, so drafts survive a tab switch. The tab is the `#<group>` fragment;
 * a section's own fragment, or any anchor inside a panel, selects its group,
 * unfolds it when empty, and focuses it. Known-empty sections fold into one line per panel.
 */
export function DetailWorkspace({
  groups,
  side,
  footer,
}: {
  groups: DetailWorkspaceGroup[];
  side?: ReactNode;
  /** After the panels, outside the tabs (debug raw data). */
  footer?: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const hydrated = useHydrated();
  // After hydration a client navigation can open on its fragment's tab; the
  // server never sees the fragment, so hydration starts on the first tab.
  const [active, setActive] = useState(
    () =>
      (hydrated ? groupFor(groups, normalizedHash(hash)) : undefined) ??
      groups[0]?.id ??
      "",
  );
  const [states, setStates] = useState<Map<string, SectionIndexState>>(
    new Map(),
  );
  const register = useCallback(
    (id: string, state: SectionIndexState | undefined) => {
      setStates((previous) => {
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
  const pendingFocus = useRef<string | undefined>(undefined);

  // Read through a ref: the groups are rebuilt every render, and only a new
  // fragment may move the selected tab.
  const groupsRef = useRef(groups);
  useLayoutEffect(() => {
    groupsRef.current = groups;
  });

  // A fragment selects its tab before paint; a section fragment also unfolds
  // and focuses that section once its panel shows.
  useLayoutEffect(() => {
    const id = normalizedHash(hash);
    if (!id) return;
    // Any other anchor (a field row, a check result) selects the panel it
    // sits in.
    const group =
      groupFor(groupsRef.current, id) ??
      rootRef.current
        ?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
        ?.closest<HTMLElement>("[data-detail-panel]")?.dataset.detailPanel;
    if (group === undefined) return;
    setActive(group);
    if (group !== id) {
      pendingFocus.current = id;
      setUnfolded((previous) =>
        previous.has(id) ? previous : new Set([...previous, id]),
      );
    }
  }, [hash]);

  useEffect(() => {
    const id = pendingFocus.current;
    if (id === undefined) return;
    const target = document.getElementById(id);
    // Wait until the section and its panel show: a hidden target cannot focus.
    if (!target || target.closest("[hidden]")) return;
    pendingFocus.current = undefined;
    if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
    target.scrollIntoView({ behavior: "instant", block: "start" });
    target.focus({ preventScroll: true });
  });

  const select = (group: string, replace = false) => {
    setActive(group);
    void navigate({
      to: ".",
      search: true,
      hash: group,
      replace,
      resetScroll: false,
      hashScrollIntoView: false,
    });
  };
  // Find-in-page revealing a panel selects its tab without a history entry.
  useUntilFound(rootRef, active, (group) => select(group, true));

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = groups.findIndex((group) => group.id === active);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % groups.length
        : event.key === "ArrowLeft"
          ? (index - 1 + groups.length) % groups.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? groups.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const group = groups[next];
    if (!group) return;
    select(group.id);
    document.getElementById(tabId(group.id))?.focus();
  };

  const isFolded = (section: IndexedSection) =>
    !unfolded.has(section.id) &&
    sectionIsFolded(section, states.get(section.id));
  const isPending = (section: IndexedSection) =>
    section.countPending === true && !unfolded.has(section.id);
  const countOf = (group: DetailWorkspaceGroup) => {
    const counts = group.sections.flatMap((section) => {
      const count = states.get(section.id)?.count;
      return count === undefined || isFolded(section) ? [] : [count];
    });
    return counts.length > 0
      ? counts.reduce((sum, count) => sum + count, 0)
      : undefined;
  };
  const unfold = (id: string) =>
    setUnfolded((previous) =>
      previous.has(id) ? previous : new Set([...previous, id]),
    );

  return (
    <div
      ref={rootRef}
      data-detail-workspace
      className="@container/record min-w-0"
    >
      <div className="grid min-w-0 grid-cols-1 @min-[800px]/record:grid-cols-[236px_minmax(0,1fr)] @min-[1001px]/record:grid-cols-[272px_minmax(0,1fr)]">
        {side ? (
          <aside
            aria-label="Record summary"
            data-detail-side
            className="min-w-0 border-border py-4 @max-[799px]/record:border-b @min-[800px]/record:border-r @min-[800px]/record:pr-5"
          >
            {side}
          </aside>
        ) : null}
        <div
          className={cn(
            "min-w-0 pt-2",
            side
              ? "@min-[800px]/record:pl-6"
              : "@min-[800px]/record:col-span-2",
          )}
        >
          <SectionIndexRegistryContext.Provider value={register}>
            <div
              role="tablist"
              aria-label="Record sections"
              className="flex h-11 min-w-0 [scrollbar-width:none] items-stretch gap-6 overflow-x-auto overscroll-x-contain border-b border-border"
            >
              {groups.map((group) => {
                const selected = group.id === active;
                const count = countOf(group);
                const empty =
                  group.sections.length > 0 && group.sections.every(isFolded);
                return (
                  <button
                    key={group.id}
                    id={tabId(group.id)}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={panelId(group.id)}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => select(group.id)}
                    onKeyDown={onTabKey}
                    className={cn(
                      "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 text-sm font-semibold whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      selected
                        ? "border-foreground-strong text-foreground-strong"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                      empty && !selected && "font-medium",
                    )}
                  >
                    {group.title}
                    {count !== undefined ? (
                      <span className="text-xs font-normal text-muted-foreground tabular-nums">
                        {formatCount(count)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {groups.map((group) => (
              <div
                key={group.id}
                id={panelId(group.id)}
                role="tabpanel"
                aria-labelledby={tabId(group.id)}
                data-detail-panel={group.id}
                hidden={group.id !== active}
                tabIndex={-1}
                className="min-w-0 space-y-(--section-gap) pt-4 pb-6 text-sm focus:outline-none"
              >
                <SectionStack sections={group.sections} unfolded={unfolded} />
                <FoldedSectionsLine
                  sections={group.sections.filter(isFolded)}
                  pending={group.sections.filter(isPending).length}
                  onUnfold={unfold}
                />
              </div>
            ))}
          </SectionIndexRegistryContext.Provider>
          {footer}
        </div>
      </div>
    </div>
  );
}
