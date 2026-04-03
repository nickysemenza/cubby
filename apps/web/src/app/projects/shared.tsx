import { Link } from "@tanstack/react-router";
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  CheckCircle2,
  Circle,
  Clock,
  ExternalLink,
  ListTodo,
  ShieldAlert,
} from "lucide-react";
import { useMemo } from "react";
import RTable from "~/app/_components/data-table/Table";
import { Badge } from "~/components/ui/badge";
import { formatCurrency } from "~/lib/utils";
import type {
  NotionProject,
  NotionPurchase,
  NotionTask,
} from "~/server/clients/notion";

// -- Category colors (matching Notion chart palette) --

export const CATEGORY_COLORS: Record<string, string> = {
  materials: "hsl(210, 60%, 55%)",
  tools: "hsl(330, 55%, 60%)",
  services: "hsl(30, 65%, 55%)",
};

export function getCategoryColor(category: string | null): string {
  if (!category) return "hsl(0, 0%, 65%)";
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

// -- Task Table --

const taskHelper = createColumnHelper<NotionTask>();

const taskColumns = [
  taskHelper.accessor("status", {
    header: "Status",
    cell: ({ getValue }) => <StatusIcon status={getValue()} />,
    size: 60,
    enableSorting: true,
  }),
  taskHelper.accessor("name", {
    header: "Task",
    cell: ({ row }) => (
      <a
        href={row.original.notionUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 hover:underline"
      >
        {row.original.name}
        <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
      </a>
    ),
    enableSorting: true,
  }),
  taskHelper.accessor("projectName", {
    header: "Project",
    cell: ({ getValue }) => {
      const name = getValue();
      if (!name) return null;
      return <Badge variant="secondary">{name}</Badge>;
    },
    enableSorting: true,
  }),
  taskHelper.accessor("category", {
    header: "Category",
    cell: ({ getValue }) => {
      const cat = getValue();
      if (!cat) return null;
      return <Badge variant="outline">{cat}</Badge>;
    },
    enableSorting: true,
  }),
  taskHelper.accessor("due", {
    header: "Due",
    cell: ({ getValue }) => {
      const due = getValue();
      if (!due) return null;
      return (
        <span className="text-muted-foreground text-xs">{formatDate(due)}</span>
      );
    },
    sortingFn: "alphanumeric",
    enableSorting: true,
  }),
];

export function TaskList({ tasks }: { tasks: NotionTask[] }) {
  const sortedData = useMemo(() => {
    const active = tasks
      .filter((t) => t.status !== "Done")
      .sort((a, b) => {
        if (!a.due && !b.due) return 0;
        if (!a.due) return 1;
        if (!b.due) return -1;
        return a.due.localeCompare(b.due);
      });
    const done = tasks.filter((t) => t.status === "Done");
    return [...active, ...done];
  }, [tasks]);

  const table = useReactTable({
    data: sortedData,
    columns: taskColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: (row) => row.id,
    initialState: {
      pagination: { pageSize: 20 },
    },
  });

  if (tasks.length === 0) {
    return <p className="text-muted-foreground text-sm">No tasks found.</p>;
  }

  return <RTable table={table} />;
}

// -- Purchase Table --

const purchaseHelper = createColumnHelper<NotionPurchase>();

const purchaseColumns = [
  purchaseHelper.accessor("name", {
    header: "Purchase",
    cell: ({ row }) => (
      <a
        href={row.original.notionUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 hover:underline"
      >
        {row.original.name}
        <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
      </a>
    ),
    enableSorting: true,
  }),
  purchaseHelper.accessor("projectName", {
    header: "Project",
    cell: ({ getValue }) => {
      const name = getValue();
      if (!name) return null;
      return <Badge variant="secondary">{name}</Badge>;
    },
    enableSorting: true,
  }),
  purchaseHelper.accessor("category", {
    header: "Category",
    cell: ({ getValue }) => {
      const cat = getValue();
      if (!cat) return null;
      return <Badge variant="outline">{cat}</Badge>;
    },
    enableSorting: true,
  }),
  purchaseHelper.accessor("subcategory", {
    header: "Subcategory",
    cell: ({ getValue }) => {
      const sub = getValue();
      if (!sub) return null;
      return <Badge variant="outline">{sub}</Badge>;
    },
    enableSorting: true,
  }),
  purchaseHelper.accessor("cost", {
    header: "Cost",
    cell: ({ getValue }) => {
      const cost = getValue();
      if (cost == null) return null;
      return <span className="font-medium">{formatCurrency(cost, 0)}</span>;
    },
    enableSorting: true,
  }),
  purchaseHelper.accessor("date", {
    header: "Date",
    cell: ({ getValue }) => {
      const date = getValue();
      if (!date) return null;
      return (
        <span className="text-muted-foreground text-xs">
          {formatDate(date)}
        </span>
      );
    },
    sortingFn: "alphanumeric",
    enableSorting: true,
  }),
];

export function PurchaseList({ purchases }: { purchases: NotionPurchase[] }) {
  const table = useReactTable({
    data: purchases,
    columns: purchaseColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: (row) => row.id,
    initialState: {
      pagination: { pageSize: 20 },
    },
  });

  if (purchases.length === 0) {
    return <p className="text-muted-foreground text-sm">No purchases found.</p>;
  }

  return <RTable table={table} />;
}

// -- Project Table --

type ProjectRow = NotionProject & { actualCost: number };

const projectHelper = createColumnHelper<ProjectRow>();

const projectColumns = [
  projectHelper.accessor("name", {
    header: "Project",
    cell: ({ row }) => (
      <Link
        to="/projects/$id"
        params={{ id: row.original.id }}
        className="flex items-center gap-1.5 font-medium hover:underline"
      >
        {row.original.icon && <span>{row.original.icon}</span>}
        {row.original.name}
      </Link>
    ),
    enableSorting: true,
  }),
  projectHelper.accessor("status", {
    header: "Status",
    cell: ({ row }) => (
      <div className="flex items-center gap-1.5">
        <StatusIcon status={row.original.status} />
        <span>{row.original.status ?? "—"}</span>
      </div>
    ),
    enableSorting: true,
  }),
  projectHelper.accessor("kind", {
    header: "Kind",
    cell: ({ getValue }) => {
      const kind = getValue();
      if (!kind) return null;
      return <Badge variant="secondary">{kind}</Badge>;
    },
    enableSorting: true,
  }),
  projectHelper.accessor("location", {
    header: "Location",
    cell: ({ getValue }) => {
      const locs = getValue();
      if (locs.length === 0) return null;
      return (
        <div className="flex flex-wrap gap-1">
          {locs.map((loc) => (
            <Badge key={loc} variant="outline">
              {loc}
            </Badge>
          ))}
        </div>
      );
    },
    enableSorting: false,
  }),
  projectHelper.accessor("costEstimate", {
    header: "Estimate",
    cell: ({ getValue }) => {
      const est = getValue();
      if (est == null) return null;
      return <span>{formatCurrency(est, 0)}</span>;
    },
    enableSorting: true,
  }),
  projectHelper.accessor("actualCost", {
    header: "Actual",
    cell: ({ row }) => {
      const actual = row.original.actualCost;
      if (actual === 0) return null;
      const est = row.original.costEstimate;
      const over = est != null && est > 0 && actual > est;
      return (
        <span className={over ? "font-medium text-destructive" : ""}>
          {formatCurrency(actual, 0)}
        </span>
      );
    },
    enableSorting: true,
  }),
  projectHelper.accessor("date", {
    header: "Date",
    cell: ({ row }) => {
      const { date, dateEnd } = row.original;
      if (!date) return null;
      return (
        <span className="text-muted-foreground text-xs">
          {formatDateRange(date, dateEnd)}
        </span>
      );
    },
    sortingFn: "alphanumeric",
    enableSorting: true,
  }),
];

export function ProjectTable({
  projects,
  purchases,
}: {
  projects: NotionProject[];
  purchases: NotionPurchase[];
}) {
  const data = useMemo(() => {
    const costByProject = new Map<string, number>();
    for (const p of purchases) {
      if (!p.projectName || !p.cost) continue;
      costByProject.set(
        p.projectName,
        (costByProject.get(p.projectName) ?? 0) + p.cost,
      );
    }

    return projects.map((p) => ({
      ...p,
      actualCost: costByProject.get(p.name) ?? 0,
    }));
  }, [projects, purchases]);

  const table = useReactTable({
    data,
    columns: projectColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: (row) => row.id,
    initialState: {
      pagination: { pageSize: 20 },
      sorting: [{ id: "date", desc: true }],
    },
  });

  if (projects.length === 0) {
    return <p className="text-muted-foreground text-sm">No projects found.</p>;
  }

  return <RTable table={table} />;
}
