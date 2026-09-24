import type {
  ProjectAttentionItem,
  ProjectAttentionType,
} from "@cubby/schemas/project";
import { CalendarCheckIcon } from "@phosphor-icons/react/dist/csr/CalendarCheck";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { CurrencyDollarIcon } from "@phosphor-icons/react/dist/csr/CurrencyDollar";
import { ProhibitIcon } from "@phosphor-icons/react/dist/csr/Prohibit";
import { RulerIcon } from "@phosphor-icons/react/dist/csr/Ruler";
import { TagIcon } from "@phosphor-icons/react/dist/csr/Tag";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import type { Icon } from "@phosphor-icons/react/lib";
import { Link } from "@tanstack/react-router";

import { Row, Stack } from "~/components/layout";
import { formatCurrency } from "~/lib/utils";

import { attentionEvidence } from "./attention-presentation";
import { formatDate } from "./project-formatting";

/**
 * Server-side rule metadata per {@link ProjectAttentionType} — icon, group
 * title, and a static (Tailwind-scannable, never templated) icon className.
 * Rendered in this fixed order (most-actionable first), not insertion order,
 * so the section reads the same regardless of what the server happened to
 * push first.
 */
const ATTENTION_GROUPS: Array<{
  type: ProjectAttentionType;
  icon: Icon;
  iconClassName: string;
  title: (count: number) => string;
}> = [
  {
    type: "overdue_task",
    icon: CalendarCheckIcon,
    iconClassName: "size-3.5 text-destructive",
    title: (n) => `${n} overdue task${n !== 1 ? "s" : ""}`,
  },
  {
    type: "blocked_work",
    icon: ProhibitIcon,
    iconClassName: "size-3.5 text-warning",
    title: (n) =>
      `${n} project${n !== 1 ? "s" : ""} blocked with no next action`,
  },
  {
    type: "stalled_project",
    icon: WarningIcon,
    iconClassName: "size-3.5 text-warning",
    title: (n) =>
      `${n} stalled project${n !== 1 ? "s" : ""} (no activity in 30 days)`,
  },
  {
    type: "past_due_planned_expense",
    icon: ClockIcon,
    iconClassName: "size-3.5 text-warning",
    title: (n) => `${n} planned expense${n !== 1 ? "s" : ""} past due`,
  },
  {
    type: "missing_budget",
    icon: CurrencyDollarIcon,
    iconClassName: "size-3.5 text-warning",
    title: (n) => `${n} project${n !== 1 ? "s" : ""} missing a cost estimate`,
  },
  {
    type: "unclassified_expense",
    icon: TagIcon,
    iconClassName: "size-3.5 text-muted-foreground",
    title: (n) => `${n} unclassified expense${n !== 1 ? "s" : ""}`,
  },
  {
    type: "date_window_drift",
    icon: RulerIcon,
    iconClassName: "size-3.5 text-muted-foreground",
    title: (n) => `${n} project date window${n !== 1 ? "s" : ""} hiding work`,
  },
];

/**
 * Compile-time proof every rule has a group. This list silently omitted
 * `date_window_drift`, so drift rows vanished from the panel while still
 * counting toward the "Needs Attention (N)" header — the header over-counted
 * and the missing rows were invisible. A new rule now fails here instead.
 */
type _AttentionGroupsAreExhaustive =
  ProjectAttentionType extends (typeof ATTENTION_GROUPS)[number]["type"]
    ? true
    : [
        "ATTENTION_GROUPS is missing",
        Exclude<
          ProjectAttentionType,
          (typeof ATTENTION_GROUPS)[number]["type"]
        >,
      ];
const _attentionGroupsAreExhaustive: _AttentionGroupsAreExhaustive = true;
void _attentionGroupsAreExhaustive;

/**
 * Server-driven Needs Attention — every item is precomputed by
 * `computeAttentionItems` (repo/project/attention.ts), including the
 * household-local "today" used for overdue/stalled detection. This component
 * only groups by `type` and renders; no date math or entity lookups happen
 * here anymore (the old client-side UTC-day workaround is gone along with
 * the raw projects/tasks/expenses props it needed).
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
    <Stack className="border border-warning/40 bg-warning/10 p-4">
      <Row
        align="center"
        gap="sm"
        className="text-sm font-medium text-warning-ink"
      >
        <WarningIcon className="size-4" />
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
              <Row key={item.key} align="center" gap="sm" className="text-xs">
                {/* Name first, evidence after — the sentence in `description`
                    is kept as the hover title, which is the one place its
                    prose form still earns its keep. */}
                <Link
                  to={item.href}
                  className="min-w-0 truncate hover:underline"
                  title={item.description}
                >
                  <span className="font-medium">{item.name}</span>
                  <span className="ml-2 text-muted-foreground">
                    {attentionEvidence(item)}
                  </span>
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
      <summary className="flex cursor-pointer items-center gap-2 text-xs font-medium text-warning-ink hover:text-warning-ink/80">
        {icon}
        {title}
      </summary>
      <Stack gap="xs" className="mt-2 ml-4">
        {children}
      </Stack>
    </details>
  );
}
