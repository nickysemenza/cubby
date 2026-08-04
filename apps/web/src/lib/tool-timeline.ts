/**
 * "Could we have used this tool on this project?" — the one definition, shared
 * by the suggestion engine, the matrix, the write guard, the Problems detector,
 * and the React cell.
 *
 * Why it exists: neither suggestion lane consulted ownership dates, so an old
 * project drew its `trade_match` candidates from the whole present-day tool
 * shelf. Measured on production, that is not a rounding error — for a 2020
 * project, 293 of the 295 inventoried tools were acquired after it ended.
 *
 * Two rules carry the correctness:
 *
 *  1. *Unknown never blocks.* A null acquisition date, a null disposal date, or
 *     a project with no window means "no restriction" — the same reading the
 *     repo gives an empty filter field. 42 of 426 tools carry no acquisition
 *     Expense at all (16 of them stocked); blocking those would be inventing a
 *     constraint out of missing data.
 *  2. *Grace only where the boundary is guessed.* An `explicit` boundary is a
 *     date the user typed on the Project, so it is taken literally. A `derived`
 *     one is just the min/max of whatever tasks and expenses happen to be
 *     dated, which routinely under-reports the real span — so it gets
 *     {@link TOOL_TIMELINE_GRACE_DAYS} of slack. `ProjectDateWindow` already
 *     carries `startSource`/`endSource`, so this costs no new plumbing.
 */
import type { ProjectDateWindow } from "@cubby/schemas/project";
import { addDays, format, parseISO, subDays } from "date-fns";

/**
 * Slack allowed on a boundary the window merely *inferred*. Wide enough to
 * absorb a project whose last dated expense predates the last real day of work
 * by a few weeks; narrow enough that the 48-day gap which produced the worst
 * live edge (M12 Force Logic Press on Kitchen Remodel) is still a conflict —
 * and that one is an explicit boundary anyway, so it gets no slack at all.
 */
export const TOOL_TIMELINE_GRACE_DAYS = 30;

/**
 * When a tool entered and left the household, derived from the ledger. Both
 * sides are nullable and null means *unknown*, never "unbounded on the far
 * side" — see rule 1 above.
 */
export type ProductOwnershipWindow = {
  /** First principal, non-future, positive Expense. */
  acquiredAt: string | null;
  /** Last exit that nothing later re-acquired; null while still owned. */
  disposedAt: string | null;
};

export const UNKNOWN_OWNERSHIP: ProductOwnershipWindow = {
  acquiredAt: null,
  disposedAt: null,
};

export type ToolTimelineConflict =
  | {
      kind: "acquired_after_end";
      /** The tool's first acquisition. */
      date: string;
      /** The project boundary it postdates, grace already applied. */
      boundary: string;
    }
  | {
      kind: "disposed_before_start";
      date: string;
      boundary: string;
    };

/** The subset of a folded project window this predicate reads. */
export type ToolTimelineProjectWindow = Pick<
  ProjectDateWindow,
  "effectiveStart" | "effectiveEnd" | "startSource" | "endSource"
>;

const shiftPlainDate = (
  date: string,
  days: number,
  direction: 1 | -1,
): string =>
  format(
    direction === 1
      ? addDays(parseISO(date), days)
      : subDays(parseISO(date), days),
    "yyyy-MM-dd",
  );

/**
 * The conflict, or null when the pair is possible (or unknowable).
 *
 * `isLive` widens a running project's end to today the same way
 * `buildResourceWindowContexts` does — an in-progress project can legitimately
 * acquire a tool after its last dated content.
 */
export function toolTimelineConflict(
  ownership: ProductOwnershipWindow,
  window: ToolTimelineProjectWindow,
  options: { isLive: boolean; today: string },
): ToolTimelineConflict | null {
  const { acquiredAt, disposedAt } = ownership;

  if (acquiredAt !== null && window.effectiveEnd !== null) {
    // A live project's window runs to today at minimum, and its end is not a
    // statement about when work stopped — so nothing can postdate it.
    const rawEnd =
      options.isLive && options.today > window.effectiveEnd
        ? options.today
        : window.effectiveEnd;
    const end =
      window.endSource === "derived" && !options.isLive
        ? shiftPlainDate(rawEnd, TOOL_TIMELINE_GRACE_DAYS, 1)
        : rawEnd;
    if (acquiredAt > end) {
      return { kind: "acquired_after_end", date: acquiredAt, boundary: end };
    }
  }

  if (disposedAt !== null && window.effectiveStart !== null) {
    const start =
      window.startSource === "derived"
        ? shiftPlainDate(window.effectiveStart, TOOL_TIMELINE_GRACE_DAYS, -1)
        : window.effectiveStart;
    if (disposedAt < start) {
      return {
        kind: "disposed_before_start",
        date: disposedAt,
        boundary: start,
      };
    }
  }

  return null;
}

/** One line a human can act on, for tooltips, error messages, and problem rows. */
export function describeToolTimelineConflict(
  conflict: ToolTimelineConflict,
  names: { toolName: string; projectName: string },
): string {
  return conflict.kind === "acquired_after_end"
    ? `${names.toolName} was acquired ${conflict.date}; ${names.projectName} ended ${conflict.boundary}.`
    : `${names.toolName} was disposed of ${conflict.date}; ${names.projectName} started ${conflict.boundary}.`;
}
