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

import type { BadgeVariant } from "~/ui/primitives/badge";

import { statusTone } from "./status-tone";

interface StatusBadgeProps {
  label: string;
  variant: BadgeVariant;
  /** Optional icon for status displays. */
  icon?: Icon;
}

const AUDIT_LABELS = new Map([
  ["create", "Created"],
  ["update", "Updated"],
  ["delete", "Deleted"],
]);

/**
 * Project + task statuses (the two DB-backed enums in `@cubby/schemas/project`)
 * mapped onto an icon and label; the tone comes from `statusTone`. Both domains
 * share this one map since their status enums are disjoint except for the
 * states they hold in common (not_started/in_progress/done). Human-facing
 * labels for these raw enum values live in `~/app/projects/shared.tsx`
 * (`PROJECT_STATUS_LABELS`/`TASK_STATUS_LABELS`) — this map is presentation
 * (icon) only.
 */
const projectStatus = new Map([
  ["done", { label: "Done", icon: CheckCircleIcon }],
  ["in_progress", { label: "In progress", icon: ClockIcon }],
  ["blocked", { label: "Blocked", icon: ShieldWarningIcon }],
  ["planning", { label: "Planning", icon: ListChecksIcon }],
  ["not_started", { label: "Not started", icon: CircleIcon }],
  ["later", { label: "Later", icon: ClockIcon }],
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
  audit: (value: string) => {
    const label = AUDIT_LABELS.get(value);
    return label === undefined ? undefined : { label };
  },
  project: (value: string) => {
    const parsed = trackerStatusSchema.safeParse(value);
    return parsed.success ? projectStatus.get(parsed.data) : undefined;
  },
} as const;

type StatusDomain = keyof typeof statusLookups;

/**
 * Get the label, icon, and Badge variant for a status value within a domain.
 * Falls back to a neutral chip when the value is unknown.
 */
export function getStatusBadgeProps(
  domain: StatusDomain,
  value: string | null | undefined,
): StatusBadgeProps {
  // The "project" domain also renders task statuses; a value only tasks have
  // (blocked, later) takes the task tone.
  const variant =
    domain === "project" && !projectStatusSchema.safeParse(value).success
      ? statusTone("task", value)
      : statusTone(domain, value);
  const found = value ? statusLookups[domain](value) : undefined;
  if (found) return { ...found, variant };
  return { label: value ?? "Unknown", variant: "slate", icon: CircleIcon };
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
