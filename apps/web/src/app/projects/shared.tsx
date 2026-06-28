import { Link } from "@tanstack/react-router";
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { partition } from "es-toolkit";
import { ExternalLink, Hammer, ListTodo, ShoppingCart } from "lucide-react";
import { useMemo } from "react";
import RTable from "~/app/_components/data-table/Table";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Description } from "~/components/ui/description";
import {
  Empty,
  EmptyHeader,
  EmptyIcon,
  EmptyTitle,
} from "~/components/ui/empty";
import { NoneValue } from "~/components/ui/none-value";
import { getStatusBadgeProps } from "~/lib/status-colors";
import { cn, formatCurrency } from "~/lib/utils";
import type {
  NotionProject,
  NotionPurchase,
  NotionTask,
} from "~/server/clients/notion";

// -- Category colors (monochrome ink ladder + ultramarine accent) --

export const CATEGORY_COLORS: Record<string, string> = {
  materials: "var(--chart-1)",
  tools: "var(--chart-5)",
  services: "var(--chart-2)",
};

export function getCategoryColor(category: string | null): string {
  if (!category) return "var(--chart-neutral)";
  return (
    CATEGORY_COLORS[normalizeCategoryKey(category)] ?? "var(--chart-neutral)"
  );
}

export function normalizeCategoryKey(category: string | null): string {
  if (!category) return "other";
  const key = category
    .replace(/^[^\w]*/, "")
    .trim()
    .toLowerCase();
  if (key in CATEGORY_COLORS) return key;
  return "other";
}

// -- Date helpers --

export function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

export function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

// -- Chart theme (consistent across all Nivo charts) --

export { nivoBarChrome, nivoChartTheme } from "~/lib/nivo-theme";

// -- Status Icon --

export function StatusIcon({ status }: { status: string | null }) {
  const { icon: Icon, className } = getStatusBadgeProps("project", status);
  // Extract just the text color from the bg+text className tuple.
  const textClass =
    className.split(" ").find((c) => c.startsWith("text-")) ??
    "text-muted-foreground";
  return Icon ? <Icon className={cn("h-4 w-4 shrink-0", textClass)} /> : null;
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
        <Description as="span" size="xs">
          {formatDate(due)}
        </Description>
      );
    },
    sortingFn: "alphanumeric",
    enableSorting: true,
  }),
];

export function TaskList({ tasks }: { tasks: NotionTask[] }) {
  const sortedData = useMemo(() => {
    const [activeTasks, done] = partition(tasks, (t) => t.status !== "Done");
    const active = activeTasks.sort((a, b) => {
      if (!a.due && !b.due) return 0;
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due.localeCompare(b.due);
    });
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
    return (
      <Empty variant="minimal" className="py-6">
        <EmptyHeader>
          <EmptyIcon icon={ListTodo} />
          <EmptyTitle>No tasks found</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
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
        <Description as="span" size="xs">
          {formatDate(date)}
        </Description>
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
    return (
      <Empty variant="minimal" className="py-6">
        <EmptyHeader>
          <EmptyIcon icon={ShoppingCart} />
          <EmptyTitle>No purchases found</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
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
        className="flex items-center gap-2 font-medium hover:underline"
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
      <Row align="center" gap="sm">
        <StatusIcon status={row.original.status} />
        <span>{row.original.status ?? <NoneValue />}</span>
      </Row>
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
        <Row wrap gap="xs">
          {locs.map((loc) => (
            <Badge key={loc} variant="outline">
              {loc}
            </Badge>
          ))}
        </Row>
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
        <Description as="span" size="xs">
          {formatDateRange(date, dateEnd)}
        </Description>
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
    return (
      <Empty variant="minimal" className="py-6">
        <EmptyHeader>
          <EmptyIcon icon={Hammer} />
          <EmptyTitle>No projects found</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  return <RTable table={table} />;
}
