import type { CostType, ProjectStatus } from "@cubby/schemas/project";
import { TRADE_LABELS } from "@cubby/schemas/project";
import { format } from "date-fns";
import { parsePlainDate } from "~/lib/plain-date";

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: "Planning",
  not_started: "Not started",
  in_progress: "In progress",
  done: "Done",
};

export function capitalize(value: string): string {
  return value.length === 0
    ? value
    : value.charAt(0).toUpperCase() + value.slice(1);
}

export function normalizeCostTypeKey(
  costType: CostType | null,
): CostType | "other" {
  return costType ?? "other";
}

export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

export const formatDate = (date: string): string =>
  format(parsePlainDate(date), "MMM d");

const formatDateWithYear = (date: string): string =>
  format(parsePlainDate(date), "MMM d, yyyy");

// NOTE: shared across the app (task due-date ranges, project date ranges,
// trade activity, etc) — see grep for `formatDateRange` before changing its
// output shape further.
export function formatDateRange(
  start: string | null,
  end: string | null,
): string {
  if (!start) return "No date";
  if (!end) return formatDate(start);
  // Most callers are short same-year ranges (a task's due window), where the
  // year would just be noise. But a project can span years (e.g. Dec 2025 →
  // Jul 2027) and "Dec 1 — Jul 1" silently drops which December/July —
  // include the year on both ends whenever the range crosses one.
  const crossesYear =
    parsePlainDate(start).getFullYear() !== parsePlainDate(end).getFullYear();
  return crossesYear
    ? `${formatDateWithYear(start)} — ${formatDateWithYear(end)}`
    : `${formatDate(start)} — ${formatDate(end)}`;
}

export { TRADE_LABELS };
