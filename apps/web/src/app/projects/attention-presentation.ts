import type { ProjectAttentionItem } from "@cubby/schemas/project";
import { match } from "ts-pattern";
import { formatCount, formatCurrency } from "~/lib/utils";
import { formatDateWithYear } from "./project-formatting";

const d = formatDateWithYear;
const days = (n: number) => `${formatCount(n)} day${n === 1 ? "" : "s"}`;

/**
 * The measured finding for one attention row, labeled — the client-side
 * counterpart to `describeAttentionItem`'s sentence.
 *
 * Shared by the Problems card subtitle and the projects dashboard row so the
 * two cannot drift, which is exactly what happened when each surface built its
 * own text. The rule itself is always the group heading on both surfaces, so
 * this carries only what varies per row.
 *
 * Every date names WHICH date it is. One card grid puts a planned-expense date
 * beside a derived date-window bound; an unlabeled "Jun 4" on each is
 * indistinguishable. Years are always shown — these rows routinely reach back
 * several years, and `formatDate`'s bare "Jun 4" reads as this year.
 */
export function attentionEvidence(item: ProjectAttentionItem): string {
  return match(item)
    .with(
      { type: "overdue_task" },
      ({ facts }) => `Due ${d(facts.due)} · ${days(facts.daysOverdue)} overdue`,
    )
    .with({ type: "blocked_work" }, ({ facts }) => {
      const n = facts.blockedTasks;
      return `${n} blocked task${n === 1 ? "" : "s"} · no unblocked next action`;
    })
    .with(
      { type: "stalled_project" },
      ({ facts }) =>
        `Last activity ${d(facts.lastActivity)} · quiet for ${days(
          facts.daysSinceActivity,
        )}`,
    )
    .with({ type: "past_due_planned_expense" }, ({ facts }) =>
      [
        `Planned for ${d(facts.plannedFor)}`,
        `${days(facts.daysPastDue)} past due`,
        facts.cost != null
          ? `${formatCurrency(facts.cost, 0)} not logged`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    )
    .with(
      { type: "missing_budget" },
      ({ facts }) =>
        `${formatCurrency(facts.spend, 0)} in spend · no cost estimate`,
    )
    .with(
      { type: "unclassified_expense" },
      ({ facts }) =>
        `${facts.date ? `Dated ${d(facts.date)}` : "No date"} · no trade, no cost`,
    )
    .with({ type: "date_window_drift" }, ({ facts }) =>
      facts.side === "start"
        ? `Start date ${d(facts.override)} hides work back to ${d(
            facts.derived,
          )} · ${days(facts.daysHidden)}`
        : `End date ${d(facts.override)} hides work through ${d(
            facts.derived,
          )} · ${days(facts.daysHidden)}`,
    )
    .exhaustive();
}
