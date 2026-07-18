import type {
  ProjectStatus,
  PurchaseCategory,
  Purchaser,
  TaskStatus,
} from "@cubby/schemas/project";
import {
  CheckCircle2,
  Circle,
  Clock,
  ListTodo,
  type LucideIcon,
  ShieldAlert,
} from "lucide-react";

interface StatusBadgeProps {
  label: string;
  /** Tailwind classes for bg + text using theme tokens. */
  className: string;
  /** Optional icon for status displays. */
  icon?: LucideIcon;
}

const auditStatus: Record<string, StatusBadgeProps> = {
  create: {
    label: "Created",
    className: "bg-secondary text-secondary-foreground",
  },
  update: {
    label: "Updated",
    className: "bg-slate/20 text-slate",
  },
  delete: {
    label: "Deleted",
    className: "bg-destructive/15 text-destructive",
  },
};

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
const projectStatus: Record<ProjectStatus | TaskStatus, StatusBadgeProps> = {
  done: {
    label: "Done",
    className: "bg-secondary text-secondary-foreground",
    icon: CheckCircle2,
  },
  in_progress: {
    label: "In progress",
    className: "bg-primary/15 text-primary",
    icon: Clock,
  },
  blocked: {
    label: "Blocked",
    className: "bg-destructive/15 text-destructive",
    icon: ShieldAlert,
  },
  planning: {
    label: "Planning",
    className: "bg-plum/20 text-plum",
    icon: ListTodo,
  },
  not_started: {
    label: "Not started",
    className: "bg-muted text-muted-foreground",
    icon: Circle,
  },
  later: {
    label: "Later",
    className: "bg-warning/30 text-accent-foreground",
    icon: Clock,
  },
};

/**
 * Project/task status -> chart fill color, using the warm chart tokens.
 * Single source of truth for SVG/nivo charts (which can't use Tailwind classes).
 */
const projectStatusChartColor: Record<ProjectStatus | TaskStatus, string> = {
  done: "var(--chart-positive)",
  in_progress: "var(--chart-1)",
  blocked: "var(--chart-negative)",
  planning: "var(--chart-5)",
  not_started: "var(--chart-neutral)",
  later: "var(--chart-2)",
};

export function getStatusChartColor(value: string | null | undefined): string {
  const map = projectStatusChartColor as Record<string, string>;
  return (value && map[value]) || "var(--chart-neutral)";
}

const DOMAINS = {
  audit: auditStatus,
  project: projectStatus,
} as const;

type StatusDomain = keyof typeof DOMAINS;

/**
 * Get badge styling for a status value within a domain.
 * Falls back to a neutral slate chip when the value is unknown.
 */
export function getStatusBadgeProps(
  domain: StatusDomain,
  value: string | null | undefined,
): StatusBadgeProps {
  const map = DOMAINS[domain] as Record<string, StatusBadgeProps>;
  if (value && map[value]) return map[value];
  return {
    label: value ?? "Unknown",
    className: "bg-slate/20 text-slate",
    icon: Circle,
  };
}

// -- Category colors (monochrome ink ladder + ultramarine accent) --

/** `purchase.category` -> chart/badge color, using the warm chart tokens. */
const CATEGORY_COLORS: Record<PurchaseCategory, string> = {
  materials: "var(--chart-1)",
  tools: "var(--chart-5)",
  services: "var(--chart-2)",
};

/**
 * Accepts a plain string, not the strict `PurchaseCategory` enum — callers
 * pass ad hoc bucket labels (e.g. treemap/donut group keys like
 * "uncategorized") through here too, not just raw purchase.category values.
 */
export function getCategoryColor(category: string | null): string {
  if (!category) return "var(--chart-neutral)";
  const map = CATEGORY_COLORS as Record<string, string>;
  return map[category] ?? "var(--chart-neutral)";
}

/** `purchase.purchaser` -> chart color. Shared purchases get the accent. */
const PURCHASER_COLORS: Record<Purchaser, string> = {
  nicky: "var(--chart-2)",
  rebecca: "var(--chart-5)",
  both: "var(--chart-1)",
};

export function getPurchaserColor(purchaser: string | null): string {
  if (!purchaser) return "var(--chart-neutral)";
  const map = PURCHASER_COLORS as Record<string, string>;
  return map[purchaser] ?? "var(--chart-neutral)";
}
