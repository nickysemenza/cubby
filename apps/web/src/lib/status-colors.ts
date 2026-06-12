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
 * Project statuses mapped onto Cubby's warm theme tokens.
 * Avoids raw Tailwind palette colors so the chips stay tonally consistent
 * with the rest of the app.
 */
const projectStatus: Record<string, StatusBadgeProps> = {
  Done: {
    label: "Done",
    className: "bg-secondary text-secondary-foreground",
    icon: CheckCircle2,
  },
  "In progress": {
    label: "In progress",
    className: "bg-primary/15 text-primary",
    icon: Clock,
  },
  Blocked: {
    label: "Blocked",
    className: "bg-destructive/15 text-destructive",
    icon: ShieldAlert,
  },
  Planning: {
    label: "Planning",
    className: "bg-plum/20 text-plum",
    icon: ListTodo,
  },
  "Not started": {
    label: "Not started",
    className: "bg-muted text-muted-foreground",
    icon: Circle,
  },
  later: {
    label: "later",
    className: "bg-warning/30 text-accent-foreground",
    icon: Clock,
  },
};

/**
 * Project status -> chart fill color, using the warm chart tokens.
 * Single source of truth for SVG/nivo charts (which can't use Tailwind classes).
 */
const projectStatusChartColor: Record<string, string> = {
  Done: "var(--chart-positive)",
  "In progress": "var(--chart-1)",
  Blocked: "var(--chart-negative)",
  Planning: "var(--chart-5)",
  "Not started": "var(--chart-neutral)",
  later: "var(--chart-2)",
};

export function getStatusChartColor(value: string | null | undefined): string {
  return (value && projectStatusChartColor[value]) || "var(--chart-neutral)";
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
  const map = DOMAINS[domain];
  if (value && map[value]) return map[value];
  return {
    label: value ?? "Unknown",
    className: "bg-slate/20 text-slate",
    icon: Circle,
  };
}
