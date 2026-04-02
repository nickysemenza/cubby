import { AlertTriangle, CalendarClock, DollarSign } from "lucide-react";
import { useMemo } from "react";
import type {
  NotionProject,
  NotionPurchase,
  NotionTask,
} from "~/server/clients/notion";
import { ProjectPill } from "./project-pill";
import { formatDate } from "./shared";

const TODAY = new Date().toISOString().slice(0, 10);

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
    const overdueTasks = tasks.filter(
      (t) => t.due && t.due < TODAY && t.status !== "Done",
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
    <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/50 p-4">
      <div className="flex items-center gap-2 font-medium text-amber-800 text-sm">
        <AlertTriangle className="h-4 w-4" />
        Needs Attention ({totalIssues})
      </div>

      {overdueTasks.length > 0 && (
        <AttentionGroup
          icon={<CalendarClock className="h-3.5 w-3.5 text-red-500" />}
          title={`${overdueTasks.length} overdue task${overdueTasks.length !== 1 ? "s" : ""}`}
        >
          {overdueTasks.map((t) => {
            const proj = t.projectName ? projectMap.get(t.projectName) : null;
            return (
              <div key={t.id} className="flex items-center gap-2 text-xs">
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
                  <span className="shrink-0 text-red-500">
                    due {formatDate(t.due)}
                  </span>
                )}
              </div>
            );
          })}
        </AttentionGroup>
      )}

      {stalledProjects.length > 0 && (
        <AttentionGroup
          icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
          title={`${stalledProjects.length} stalled project${stalledProjects.length !== 1 ? "s" : ""} (no purchases in 30 days)`}
        >
          <div className="flex flex-wrap gap-1.5">
            {stalledProjects.map((p) => (
              <ProjectPill key={p.id} project={p} />
            ))}
          </div>
        </AttentionGroup>
      )}

      {missingEstimates.length > 0 && (
        <AttentionGroup
          icon={<DollarSign className="h-3.5 w-3.5 text-amber-500" />}
          title={`${missingEstimates.length} active project${missingEstimates.length !== 1 ? "s" : ""} missing cost estimates`}
        >
          <div className="flex flex-wrap gap-1.5">
            {missingEstimates.map((p) => (
              <ProjectPill key={p.id} project={p} />
            ))}
          </div>
        </AttentionGroup>
      )}
    </div>
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
      <summary className="flex cursor-pointer items-center gap-2 font-medium text-amber-900 text-xs hover:text-amber-700">
        {icon}
        {title}
      </summary>
      <div className="mt-1.5 ml-5 space-y-1">{children}</div>
    </details>
  );
}
