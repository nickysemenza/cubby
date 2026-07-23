import type {
  ProjectAttentionItem,
  ProjectAttentionType,
} from "@cubby/schemas/project";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Ban,
  CalendarClock,
  Clock,
  DollarSign,
  type LucideIcon,
  Tag,
} from "lucide-react";
import { Row, Stack } from "~/components/layout";
import { formatCurrency } from "~/lib/utils";
import { formatDate } from "./shared";

/**
 * Server-side rule metadata per {@link ProjectAttentionType} — icon, group
 * title, and a static (Tailwind-scannable, never templated) icon className.
 * Rendered in this fixed order (most-actionable first), not insertion order,
 * so the section reads the same regardless of what the server happened to
 * push first.
 */
const ATTENTION_GROUPS: Array<{
  type: ProjectAttentionType;
  icon: LucideIcon;
  iconClassName: string;
  title: (count: number) => string;
}> = [
  {
    type: "overdue_task",
    icon: CalendarClock,
    iconClassName: "size-3.5 text-destructive",
    title: (n) => `${n} overdue task${n !== 1 ? "s" : ""}`,
  },
  {
    type: "blocked_work",
    icon: Ban,
    iconClassName: "size-3.5 text-warning",
    title: (n) =>
      `${n} project${n !== 1 ? "s" : ""} blocked with no next action`,
  },
  {
    type: "stalled_project",
    icon: AlertTriangle,
    iconClassName: "size-3.5 text-warning",
    title: (n) =>
      `${n} stalled project${n !== 1 ? "s" : ""} (no activity in 30 days)`,
  },
  {
    type: "past_due_planned_purchase",
    icon: Clock,
    iconClassName: "size-3.5 text-warning",
    title: (n) => `${n} planned purchase${n !== 1 ? "s" : ""} past due`,
  },
  {
    type: "missing_budget",
    icon: DollarSign,
    iconClassName: "size-3.5 text-warning",
    title: (n) => `${n} project${n !== 1 ? "s" : ""} missing a cost estimate`,
  },
  {
    type: "unclassified_purchase",
    icon: Tag,
    iconClassName: "size-3.5 text-muted-foreground",
    title: (n) => `${n} unclassified purchase${n !== 1 ? "s" : ""}`,
  },
];

/**
 * Server-driven Needs Attention — every item is precomputed by
 * `computeAttentionItems` (repo/project/attention.ts), including the
 * household-local "today" used for overdue/stalled detection. This component
 * only groups by `type` and renders; no date math or entity lookups happen
 * here anymore (the old client-side UTC-day workaround is gone along with
 * the raw projects/tasks/purchases props it needed).
 */
export function NeedsAttention({ items }: { items: ProjectAttentionItem[] }) {
  if (items.length === 0) return null;

  const byType = new Map<ProjectAttentionType, ProjectAttentionItem[]>();
  for (const item of items) {
    const group = byType.get(item.type);
    if (group) group.push(item);
    else byType.set(item.type, [item]);
  }

  return (
    <Stack className="rounded-lg border border-warning/40 bg-warning/10 p-4">
      <Row align="center" gap="sm" className="font-medium text-sm text-warning">
        <AlertTriangle className="size-4" />
        Needs Attention ({items.length})
      </Row>

      {ATTENTION_GROUPS.map(({ type, icon: Icon, iconClassName, title }) => {
        const group = byType.get(type);
        if (!group || group.length === 0) return null;
        return (
          <AttentionGroup
            key={type}
            icon={<Icon className={iconClassName} />}
            title={title(group.length)}
          >
            {group.map((item) => (
              <Row
                key={`${item.entityType}-${item.entityId}`}
                align="center"
                gap="sm"
                className="text-xs"
              >
                <Link to={item.href} className="truncate hover:underline">
                  {item.description}
                </Link>
                {item.date && (
                  <span className="shrink-0 text-muted-foreground">
                    {formatDate(item.date)}
                  </span>
                )}
                {item.amount != null && (
                  <span className="shrink-0 text-muted-foreground">
                    {formatCurrency(item.amount, 0)}
                  </span>
                )}
              </Row>
            ))}
          </AttentionGroup>
        );
      })}
    </Stack>
  );
}

function AttentionGroup({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer items-center gap-2 font-medium text-warning text-xs hover:text-warning/80">
        {icon}
        {title}
      </summary>
      <Stack gap="xs" className="mt-2 ml-4">
        {children}
      </Stack>
    </details>
  );
}
