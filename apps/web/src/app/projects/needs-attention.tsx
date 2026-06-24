import { AlertTriangle, CalendarClock, DollarSign } from "lucide-react";
import { useMemo } from "react";
import { Row, Stack } from "~/components/layout";
import type {
  NotionProject,
  NotionPurchase,
  NotionTask,
} from "~/server/clients/notion";
import { ProjectPill } from "./project-pill";
import { formatDate } from "./shared";

export function NeedsAttention({
  projects,
  tasks,
  purchases,
}: {
  projects: NotionProject[];
  tasks: NotionTask[];
  purchases: NotionPurchase[];
}) {
  const projectMap = useMemo(
    () => new Map(projects.map((p) => [p.name, p])),
    [projects],
  );

  const { overdueTasks, stalledProjects, missingEstimates } = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const overdueTasks = tasks.filter(
      (t) => t.due && t.due < today && t.status !== "Done",
    );

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoff = thirtyDaysAgo.toISOString().slice(0, 10);

    const recentPurchaseProjects = new Set<string>();
    for (const p of purchases) {
      if (p.projectName && p.date && p.date >= cutoff) {
        recentPurchaseProjects.add(p.projectName);
      }
    }

    const activeProjects = projects.filter(
      (p) => p.status && p.status !== "Done" && p.status !== "Not started",
    );

    const stalledProjects = activeProjects.filter(
      (p) => !recentPurchaseProjects.has(p.name),
    );

    const missingEstimates = activeProjects.filter(
      (p) => !p.costEstimate || p.costEstimate <= 0,
    );

    return { overdueTasks, stalledProjects, missingEstimates };
  }, [projects, tasks, purchases]);

  const totalIssues =
    overdueTasks.length + stalledProjects.length + missingEstimates.length;

  if (totalIssues === 0) return null;

  return (
    <Stack className="rounded-lg border border-warning/40 bg-warning/10 p-4">
      <Row align="center" gap="sm" className="font-medium text-sm text-warning">
        <AlertTriangle className="h-4 w-4" />
        Needs Attention ({totalIssues})
      </Row>

      {overdueTasks.length > 0 && (
        <AttentionGroup
          icon={<CalendarClock className="h-3.5 w-3.5 text-destructive" />}
          title={`${overdueTasks.length} overdue task${overdueTasks.length !== 1 ? "s" : ""}`}
        >
          {overdueTasks.map((t) => {
            const proj = t.projectName ? projectMap.get(t.projectName) : null;
            return (
              <Row key={t.id} align="center" gap="sm" className="text-xs">
                <a
                  href={t.notionUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate hover:underline"
                >
                  {t.name}
                </a>
                {proj && <ProjectPill project={proj} />}
                {t.due && (
                  <span className="shrink-0 text-destructive">
                    due {formatDate(t.due)}
                  </span>
                )}
              </Row>
            );
          })}
        </AttentionGroup>
      )}

      {stalledProjects.length > 0 && (
        <AttentionGroup
          icon={<AlertTriangle className="h-3.5 w-3.5 text-warning" />}
          title={`${stalledProjects.length} stalled project${stalledProjects.length !== 1 ? "s" : ""} (no purchases in 30 days)`}
        >
          <Row wrap gap="sm">
            {stalledProjects.map((p) => (
              <ProjectPill key={p.id} project={p} />
            ))}
          </Row>
        </AttentionGroup>
      )}

      {missingEstimates.length > 0 && (
        <AttentionGroup
          icon={<DollarSign className="h-3.5 w-3.5 text-warning" />}
          title={`${missingEstimates.length} active project${missingEstimates.length !== 1 ? "s" : ""} missing cost estimates`}
        >
          <Row wrap gap="sm">
            {missingEstimates.map((p) => (
              <ProjectPill key={p.id} project={p} />
            ))}
          </Row>
        </AttentionGroup>
      )}
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
