/**
 * Date overlap narrows candidates; same-trade and exact-product history
 * distinguish concurrent projects. History and derived dates must already
 * exclude the reviewed expense so its assignment cannot vote for itself.
 * This pure module also excludes the current project before taking the limit.
 */

/**
 * Minimal shape of a project option — matches `projectOptionsOut`.
 *
 * The bounds are the EFFECTIVE window (the manual `startDate`/`endDate`
 * override when set, else the window derived from the project's own tasks and
 * expenses plus its live sub-projects), already folded server-side by
 * `projectNameOptions`. Ranking against the raw override columns is what made
 * suggestions miss: most projects leave them null, and a hand-typed one goes
 * stale the moment the work runs long.
 *
 * Deliberately NOT `Pick<ProjectOptionsOut, ...>`: this pure module (see file
 * header — no `~/`-aliased imports, so the unit-test project can import it)
 * has its own backtest fixtures with plain, non-shortcode-looking ids
 * ("kitchen-remodel"), which a branded `ProjectShortcode` field would reject.
 */
export interface SuggestableProject {
  id: string;
  name: string;
  effectiveStart: string | null;
  effectiveEnd: string | null;
}

/** One cell of the project x trade count matrix — matches `expenseTradeAffinityOut`. */
export interface TradeAffinityCell {
  projectId: string;
  trade: string;
  count: number;
  exactProductCount?: number;
}

export interface ProjectSuggestion {
  id: string;
  name: string;
  /** Same-trade expenses already on this project — the ranking weight. */
  affinity: number;
  exactProductCount: number;
}

/** Whole days between two `YYYY-MM-DD` strings, or null if either is absent. */
function spanInDays(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms / 86_400_000;
}

/** Keep inline alternatives small enough to review beside the current link. */
const MAX_PROJECT_SUGGESTIONS = 3;

/**
 * Rank the projects that were running when `expenseDate` was spent.
 *
 * `today` must come from `householdLocalDate()` — an open-ended project (start
 * but no end) is treated as still running, and that boundary has to be the
 * household's local day, not UTC.
 */
export function rankProjectSuggestions(
  expense: { date: string | null; trade: string; projectId?: string | null },
  projects: readonly SuggestableProject[],
  affinity: readonly TradeAffinityCell[],
  today: string,
  limit: number = MAX_PROJECT_SUGGESTIONS,
): ProjectSuggestion[] {
  // No date means no window to intersect — offer nothing rather than guess.
  if (!expense.date) return [];

  const sameTradeCounts = new Map<string, number>();
  const exactProductCounts = new Map<string, number>();
  for (const cell of affinity) {
    if (cell.trade === expense.trade) {
      sameTradeCounts.set(cell.projectId, cell.count);
      exactProductCounts.set(cell.projectId, cell.exactProductCount ?? 0);
    }
  }

  return projects
    .filter((project) => {
      // A project with no effective start has no window to fall inside — no
      // override, no dated tasks or expenses, no dated sub-projects either.
      if (project.id === expense.projectId || !project.effectiveStart)
        return false;
      const end = project.effectiveEnd ?? today;
      return expense.date! >= project.effectiveStart && expense.date! <= end;
    })
    .map((project) => ({
      id: project.id,
      name: project.name,
      affinity: sameTradeCounts.get(project.id) ?? 0,
      exactProductCount: exactProductCounts.get(project.id) ?? 0,
      span: spanInDays(project.effectiveStart, project.effectiveEnd),
    }))
    .sort((a, b) => {
      // Strongest same-trade history first.
      if (a.affinity !== b.affinity) return b.affinity - a.affinity;
      if (a.exactProductCount !== b.exactProductCount)
        return b.exactProductCount - a.exactProductCount;
      // Then the tighter window: an expense inside a two-week sub-project is
      // better explained by it than by the year-long parent that contains it.
      // Open-ended projects (null span) sort last — they contain everything.
      if (a.span !== b.span) {
        if (a.span === null) return 1;
        if (b.span === null) return -1;
        return a.span - b.span;
      }
      return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    })
    .slice(0, limit)
    .map(({ id, name, affinity: score, exactProductCount }) => ({
      id,
      name,
      affinity: score,
      exactProductCount,
    }));
}
