import {
  type ProjectOut,
  type ProjectStatus,
  type PurchaseCategory,
  type PurchaseOut,
  projectStatusValues,
  type TaskOut,
  type TaskStatus,
} from "@cubby/schemas/project";
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
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { Description } from "~/components/ui/description";
import {
  Empty,
  EmptyHeader,
  EmptyIcon,
  EmptyTitle,
} from "~/components/ui/empty";
import { getStatusBadgeProps } from "~/lib/status-colors";
import { cn, formatCurrency } from "~/lib/utils";

/**
 * Human-facing labels for the raw DB enum values (`@cubby/schemas/project`).
 * Single source of truth for status column headers, badges, and filter chips
 * across the dashboard/detail page/charts — never string-match the raw enum
 * value for display text.
 */
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: "Planning",
  not_started: "Not started",
  in_progress: "In progress",
  done: "Done",
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: "Not started",
  later: "Later",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

/** Status select options for the detail page's inline `EditableCell` status field. */
export const PROJECT_STATUS_OPTIONS: FilterableComboboxItem[] =
  projectStatusValues.map((s) => ({
    value: s,
    label: PROJECT_STATUS_LABELS[s],
  }));

/** Title-cases a single lowercase enum-ish token (project kind, purchase category). */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

// -- Category colors --

export { getCategoryColor } from "~/lib/status-colors";

/**
 * `purchase.category` is now a strict enum (no more Notion emoji prefixes to
 * strip), so this is just a null-coalesce — kept as a named helper since every
 * chart file already calls it as the "category or other" bucket key.
 */
export function normalizeCategoryKey(
  category: PurchaseCategory | null,
): string {
  return category ?? "other";
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

export function StatusIcon({ status }: { status: ProjectStatus | TaskStatus }) {
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

// -- Project link pill (used by task/purchase tables) --

function ProjectLink({
  projectId,
  projectName,
}: {
  projectId: string | null;
  projectName: string | null;
}) {
  if (!projectName) return null;
  if (!projectId) return <Badge variant="secondary">{projectName}</Badge>;
  return (
    <Link to="/projects/$id" params={{ id: projectId }}>
      <Badge variant="secondary" className="cursor-pointer hover:bg-muted">
        {projectName}
      </Badge>
    </Link>
  );
}

// -- Task Table --

const taskHelper = createColumnHelper<TaskOut>();

const taskColumns = [
  taskHelper.accessor("status", {
    header: "Status",
    cell: ({ getValue }) => <StatusIcon status={getValue()} />,
    size: 60,
    enableSorting: true,
  }),
  taskHelper.accessor("name", {
    header: "Task",
    cell: ({ row }) => row.original.name,
    enableSorting: true,
  }),
  taskHelper.accessor("projectName", {
    header: "Project",
    cell: ({ row }) => (
      <ProjectLink
        projectId={row.original.projectId}
        projectName={row.original.projectName}
      />
    ),
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
  taskHelper.accessor("dueDate", {
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

export function TaskList({ tasks }: { tasks: TaskOut[] }) {
  const sortedData = useMemo(() => {
    const [activeTasks, done] = partition(tasks, (t) => t.status !== "done");
    const active = activeTasks.sort((a, b) => {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
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

const purchaseHelper = createColumnHelper<PurchaseOut>();

const purchaseColumns = [
  purchaseHelper.accessor("name", {
    header: "Purchase",
    cell: ({ row }) => {
      const url = row.original.url;
      if (!url) return row.original.name;
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 hover:underline"
        >
          {row.original.name}
          <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
        </a>
      );
    },
    enableSorting: true,
  }),
  purchaseHelper.accessor("projectName", {
    header: "Project",
    cell: ({ row }) => (
      <ProjectLink
        projectId={row.original.projectId}
        projectName={row.original.projectName}
      />
    ),
    enableSorting: true,
  }),
  purchaseHelper.accessor("category", {
    header: "Category",
    cell: ({ getValue }) => {
      const cat = getValue();
      if (!cat) return null;
      return <Badge variant="outline">{capitalize(cat)}</Badge>;
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

export function PurchaseList({ purchases }: { purchases: PurchaseOut[] }) {
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

const projectHelper = createColumnHelper<ProjectOut>();

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
        <span>{PROJECT_STATUS_LABELS[row.original.status]}</span>
      </Row>
    ),
    enableSorting: true,
  }),
  projectHelper.accessor("kind", {
    header: "Kind",
    cell: ({ getValue }) => {
      const kind = getValue();
      if (!kind) return null;
      return <Badge variant="secondary">{capitalize(kind)}</Badge>;
    },
    enableSorting: true,
  }),
  projectHelper.accessor("locations", {
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
  projectHelper.accessor((row) => row.rollup.spent, {
    id: "actual",
    header: "Actual",
    cell: ({ row }) => {
      const actual = row.original.rollup.spent;
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
  projectHelper.accessor("startDate", {
    header: "Date",
    cell: ({ row }) => {
      const { startDate, endDate } = row.original;
      if (!startDate) return null;
      return (
        <Description as="span" size="xs">
          {formatDateRange(startDate, endDate)}
        </Description>
      );
    },
    sortingFn: "alphanumeric",
    enableSorting: true,
  }),
];

export function ProjectTable({ projects }: { projects: ProjectOut[] }) {
  const table = useReactTable({
    data: projects,
    columns: projectColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: (row) => row.id,
    initialState: {
      pagination: { pageSize: 20 },
      sorting: [{ id: "startDate", desc: true }],
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
