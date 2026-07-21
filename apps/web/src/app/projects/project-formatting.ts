import type { CostType, ProjectStatus } from "@cubby/schemas/project";
import { TRADE_LABELS } from "@cubby/schemas/project";
import { format } from "date-fns";

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

const parsePlainDate = (value: string): Date => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
};

export const formatDate = (date: string): string =>
  format(parsePlainDate(date), "MMM d");

export function formatDateRange(
  start: string | null,
  end: string | null,
): string {
  if (!start) return "No date";
  if (!end) return formatDate(start);
  return `${formatDate(start)} — ${formatDate(end)}`;
}

export { TRADE_LABELS };
