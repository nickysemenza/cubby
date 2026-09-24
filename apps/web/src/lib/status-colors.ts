import {
  costTypeSchema,
  projectStatusSchema,
  taskStatusSchema,
} from "@cubby/schemas/project";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { ShieldWarningIcon } from "@phosphor-icons/react/dist/csr/ShieldWarning";
import type { Icon } from "@phosphor-icons/react/lib";
import { z } from "zod";

interface StatusBadgeProps {
  label: string;
  /** Tailwind classes for bg + text using theme tokens. */
  className: string;
  /** Optional icon for status displays. */
  icon?: Icon;
}

const auditStatus = new Map<string, StatusBadgeProps>([
  [
    "create",
    {
      label: "Created",
      className: "bg-secondary text-secondary-foreground",
    },
  ],
  [
    "update",
    {
      label: "Updated",
      className: "bg-slate/20 text-slate",
    },
  ],
  [
    "delete",
    {
      label: "Deleted",
      className: "bg-destructive/15 text-destructive",
    },
  ],
]);

/**
 * Project + task statuses (the two DB-backed enums in `@cubby/schemas/project`)
 * mapped onto Cubby's warm theme tokens. Both domains share this one map since
 * their status enums are disjoint except for the three states they hold in
 * common (not_started/in_progress/done) — Avoids raw Tailwind palette colors
 * so the chips stay tonally consistent with the rest of the app. Human-facing
 * labels for these raw enum values live in `~/app/projects/shared.tsx`
 * (`PROJECT_STATUS_LABELS`/`TASK_STATUS_LABELS`) — this map is presentation
 * (icon/color) only.
 */
const projectStatus = new Map([
  [
    "done",
    {
      label: "Done",
      className: "bg-secondary text-secondary-foreground",
      icon: CheckCircleIcon,
    },
  ],
  [
    "in_progress",
    {
      label: "In progress",
      className: "bg-primary/15 text-primary",
      icon: ClockIcon,
    },
  ],
  [
    "blocked",
    {
      label: "Blocked",
      className: "bg-destructive/15 text-destructive",
      icon: ShieldWarningIcon,
    },
  ],
  [
    "planning",
    {
      label: "Planning",
      className: "bg-plum/20 text-plum",
      icon: ListChecksIcon,
    },
  ],
  [
    "not_started",
    {
      label: "Not started",
      className: "bg-muted text-muted-foreground",
      icon: CircleIcon,
    },
  ],
  [
    "later",
    {
      label: "Later",
      className: "bg-warning/30 text-accent-foreground",
      icon: ClockIcon,
    },
  ],
] as const);

const trackerStatusSchema = z.union([projectStatusSchema, taskStatusSchema]);

/**
 * Project/task status -> chart fill color, using the warm chart tokens.
 * Single source of truth for SVG/nivo charts (which can't use Tailwind classes).
 */
const projectStatusChartColor = new Map([
  ["done", "var(--chart-positive)"],
  ["in_progress", "var(--chart-1)"],
  ["blocked", "var(--chart-negative)"],
  ["planning", "var(--chart-5)"],
  ["not_started", "var(--chart-neutral)"],
  ["later", "var(--chart-2)"],
] as const);

export function getStatusChartColor(value: string | null | undefined): string {
  const parsed = trackerStatusSchema.safeParse(value);
  return parsed.success
    ? (projectStatusChartColor.get(parsed.data) ?? "var(--chart-neutral)")
    : "var(--chart-neutral)";
}

const statusLookups = {
  audit: (value: string) => auditStatus.get(value),
  project: (value: string) => {
    const parsed = trackerStatusSchema.safeParse(value);
    return parsed.success ? projectStatus.get(parsed.data) : undefined;
  },
} as const;

type StatusDomain = keyof typeof statusLookups;

/**
 * Get badge styling for a status value within a domain.
 * Falls back to a neutral slate chip when the value is unknown.
 */
export function getStatusBadgeProps(
  domain: StatusDomain,
  value: string | null | undefined,
): StatusBadgeProps {
  const found = value ? statusLookups[domain](value) : undefined;
  if (found) return found;
  return {
    label: value ?? "Unknown",
    className: "bg-slate/20 text-slate",
    icon: CircleIcon,
  };
}

// -- Cost-type colors (monochrome ink ladder + ultramarine accent) --

/** `expense.costType` -> chart/badge color, using the warm chart tokens. */
const COST_TYPE_COLORS = new Map([
  ["materials", "var(--chart-1)"],
  ["tools", "var(--chart-5)"],
  ["services", "var(--chart-2)"],
] as const);

/**
 * Accepts a plain string, not the strict `CostType` enum — callers pass ad
 * hoc bucket labels (e.g. treemap/donut group keys like "uncategorized")
 * through here too, not just raw expense.costType values.
 */
export function getCostTypeColor(costType: string | null): string {
  if (!costType) return "var(--chart-neutral)";
  const parsed = costTypeSchema.safeParse(costType);
  return parsed.success
    ? (COST_TYPE_COLORS.get(parsed.data) ?? "var(--chart-neutral)")
    : "var(--chart-neutral)";
}
