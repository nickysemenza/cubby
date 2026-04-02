import {
  CheckCircle2,
  Circle,
  Clock,
  ExternalLink,
  ListTodo,
  ShieldAlert,
  ShoppingCart,
} from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { formatCurrency } from "~/lib/utils";
import type { NotionPurchase, NotionTask } from "~/server/clients/notion";

// -- Category colors (matching Notion chart palette) --

export const CATEGORY_COLORS: Record<string, string> = {
  materials: "hsl(210, 60%, 55%)",
  tools: "hsl(330, 55%, 60%)",
  services: "hsl(30, 65%, 55%)",
};

export function getCategoryColor(category: string | null): string {
  if (!category) return "hsl(0, 0%, 65%)";
  // Strip emoji prefix for matching
  const key = category
    .replace(/^[^\w]*/, "")
    .trim()
    .toLowerCase();
  return CATEGORY_COLORS[key] ?? "hsl(0, 0%, 65%)";
}

// -- Status Icon --

export function StatusIcon({ status }: { status: string | null }) {
  switch (status) {
    case "Done":
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />;
    case "In progress":
      return <Clock className="h-4 w-4 shrink-0 text-blue-500" />;
    case "Blocked":
      return <ShieldAlert className="h-4 w-4 shrink-0 text-red-500" />;
    case "Planning":
      return <ListTodo className="h-4 w-4 shrink-0 text-purple-500" />;
    default:
      return <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
}

// -- Date formatting --

export function formatDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function formatDateRange(
  start: string | null,
  end: string | null,
): string {
  if (!start) return "No date";
  if (!end) return formatDate(start);
  return `${formatDate(start)} — ${formatDate(end)}`;
}

// -- Task Row --

export function TaskRow({ task }: { task: NotionTask }) {
  return (
    <a
      href={task.notionUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted/50"
    >
      <StatusIcon status={task.status} />
      <span className="min-w-0 flex-1 truncate">{task.name}</span>
      {task.projectName && (
        <Badge variant="secondary" className="shrink-0">
          {task.projectName}
        </Badge>
      )}
      {task.category && (
        <Badge variant="outline" className="shrink-0">
          {task.category}
        </Badge>
      )}
      {task.due && (
        <span className="shrink-0 text-muted-foreground text-xs">
          {formatDate(task.due)}
        </span>
      )}
      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
    </a>
  );
}

// -- Purchase Row --

export function PurchaseRow({ purchase }: { purchase: NotionPurchase }) {
  return (
    <a
      href={purchase.notionUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted/50"
    >
      <ShoppingCart className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{purchase.name}</span>
      {purchase.projectName && (
        <Badge variant="secondary" className="shrink-0">
          {purchase.projectName}
        </Badge>
      )}
      {purchase.category && (
        <Badge variant="outline" className="shrink-0">
          {purchase.category}
        </Badge>
      )}
      {purchase.cost != null && (
        <span className="shrink-0 font-medium">
          {formatCurrency(purchase.cost, 0)}
        </span>
      )}
      {purchase.date && (
        <span className="shrink-0 text-muted-foreground text-xs">
          {formatDate(purchase.date)}
        </span>
      )}
      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
    </a>
  );
}

// -- Task List --

export function TaskList({ tasks }: { tasks: NotionTask[] }) {
  const active = tasks
    .filter((t) => t.status !== "Done")
    .sort((a, b) => {
      if (!a.due && !b.due) return 0;
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due.localeCompare(b.due);
    });
  const done = tasks.filter((t) => t.status === "Done");

  if (active.length === 0 && done.length === 0) {
    return <p className="text-muted-foreground text-sm">No tasks found.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        {active.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </div>
      {done.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-muted-foreground text-sm hover:text-foreground">
            Completed ({done.length})
          </summary>
          <div className="mt-2 space-y-1">
            {done.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// -- Purchase List --

export function PurchaseList({ purchases }: { purchases: NotionPurchase[] }) {
  if (purchases.length === 0) {
    return <p className="text-muted-foreground text-sm">No purchases found.</p>;
  }

  return (
    <div className="space-y-1">
      {purchases.map((purchase) => (
        <PurchaseRow key={purchase.id} purchase={purchase} />
      ))}
    </div>
  );
}
