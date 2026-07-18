import {
  type ProjectKind,
  type ProjectOut,
  type ProjectStatus,
  type PurchaseCategory,
  type PurchaseOut,
  projectStatusValues,
  type TaskOut,
  type TaskStatus,
} from "@cubby/schemas/project";
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { format } from "date-fns";
import { partition } from "es-toolkit";
import { ExternalLink, ListTodo, ShoppingCart } from "lucide-react";
import { useMemo } from "react";
import {
  createCurrencyColumn,
  createFilterableSelectColumn,
  createPlainDateColumn,
  createProjectLinkColumn,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useEntityPreview } from "~/app/_components/hooks/useEntityPreview";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import {
  purchaseCategoryLabels,
  purchaseCategoryOptions,
} from "~/app/purchases/purchase-options";
import {
  TASK_STATUS_LABELS,
  taskStatusBadgeVariant,
  taskStatusOptions,
} from "~/app/tasks/task-options";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import {
  Empty,
  EmptyHeader,
  EmptyIcon,
  EmptyTitle,
} from "~/components/ui/empty";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { projectMutationInvalidateKeys } from "~/lib/query-keys";
import { buildSelectOptions } from "~/lib/select-options";
import { getStatusBadgeProps } from "~/lib/status-colors";
import { cn, formatCurrency } from "~/lib/utils";
import { projectKindOptions } from "./project-options";

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

// Task labels live with the task options (see the note there on import
// direction); re-exported here for this file's many existing consumers.
export { TASK_STATUS_LABELS } from "~/app/tasks/task-options";

/** Status select options for the detail page's inline `EditableCell` status field. */
export const PROJECT_STATUS_OPTIONS: FilterableComboboxItem[] =
  buildSelectOptions(projectStatusValues, PROJECT_STATUS_LABELS);

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

/**
 * Parses a "YYYY-MM-DD" plain-date string (no time component) into a local
 * `Date` at midnight via its components, rather than `new Date(iso+"T00:00:00")`.
 * Mirrors the private `parsePlainDate` helper in columnHelpers.tsx (not
 * exported from there, so duplicated here) — same day-precision guarantee its
 * comment documents.
 */
function parsePlainDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

export function formatDate(iso: string): string {
  return format(parsePlainDate(iso), "MMM d");
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

const taskHelper = createColumnHelper<TaskOut>();

const taskColumns = [
  createFilterableSelectColumn(taskHelper, "status", {
    header: "Status",
    className: "w-32",
    placeholder: "Filter by status...",
    selectOptions: taskStatusOptions,
    renderCell: (status: TaskStatus) => (
      <Badge variant={taskStatusBadgeVariant[status]}>
        {TASK_STATUS_LABELS[status]}
      </Badge>
    ),
  }),
  taskHelper.accessor("name", {
    header: "Task",
    cell: ({ row }) => row.original.name,
    enableSorting: true,
  }),
  createProjectLinkColumn(taskHelper, { className: "w-40" }),
  taskHelper.accessor("category", {
    header: "Category",
    cell: ({ getValue }) => {
      const cat = getValue();
      if (!cat) return null;
      return <Badge variant="outline">{cat}</Badge>;
    },
    enableSorting: true,
  }),
  createPlainDateColumn(taskHelper, "dueDate", {
    header: "Due",
    className: "w-28",
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
  createProjectLinkColumn(purchaseHelper, { className: "w-40" }),
  createFilterableSelectColumn(purchaseHelper, "category", {
    header: "Category",
    className: "w-28",
    placeholder: "Filter by category...",
    selectOptions: purchaseCategoryOptions,
    renderCell: (cat: PurchaseCategory | null) =>
      cat ? purchaseCategoryLabels[cat] : <NoneValue />,
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
  createPlainDateColumn(purchaseHelper, "date", {
    header: "Date",
    className: "w-28",
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

const PROJECT_KIND_FILTER_OPTIONS: FilterableComboboxItem[] = [
  { value: "", label: "All kinds" },
  ...projectKindOptions,
];

/**
 * Renders through `useEntityList`/`useStandardColumns` (like `TaskList`/
 * `PurchaseList` above, and mirroring `tasklist.tsx`/`purchaselist.tsx`)
 * rather than a client-side `useReactTable` over the dashboard's
 * already-fetched+filtered `projects` array — it drives its own
 * `project.list` query instead (cache-independent of the dashboard's one
 * `project.dashboard` fetch). That's a deliberate trade against the
 * dashboard's status/kind/location filters (this table doesn't see them; it
 * has its own inline column filters + search), in exchange for server-backed
 * infinite scroll, inline editing, and delete — all free from `useEntityList`.
 * Takes no props; mounted bare from the dashboard's DATA tab.
 */
export function ProjectTable() {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<ProjectOut>(), []);

  const updateProjectMutation = useUpdateMutation({
    mutationFn: api.project.update.mutationOptions,
    entity: "project",
    invalidateKeys: projectMutationInvalidateKeys,
  });

  const nameEditable = useNameEditable<ProjectOut>(
    updateProjectMutation.mutateAsync,
  );

  const deletableConfig = useDeletableConfig({
    mutationFn: api.project.delete.mutationOptions,
    entityLabel: "Project",
    invalidateKeys: projectMutationInvalidateKeys,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: updateProjectMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      createFilterableSelectColumn(columnHelper, "status", {
        header: "Status",
        className: "w-32",
        placeholder: "Filter by status...",
        selectOptions: PROJECT_STATUS_OPTIONS,
        renderCell: (status: ProjectStatus) => (
          <Row align="center" gap="xs">
            <StatusIcon status={status} />
            <span>{PROJECT_STATUS_LABELS[status]}</span>
          </Row>
        ),
        mobile: { slot: "subtitle", priority: 10 },
        editable: {
          onSave: async (newStatus, project) => {
            await updateProjectMutation.mutateAsync({
              id: project.id,
              data: { status: newStatus },
            });
          },
        },
      }),
      createFilterableSelectColumn(columnHelper, "kind", {
        header: "Kind",
        className: "w-32",
        placeholder: "Filter by kind...",
        selectOptions: projectKindOptions,
        renderCell: (kind: ProjectKind | null) =>
          kind ? (
            <Badge variant="secondary">{capitalize(kind)}</Badge>
          ) : (
            <NoneValue />
          ),
        mobile: { slot: "meta", priority: 20 },
        editable: {
          onSave: async (newKind, project) => {
            await updateProjectMutation.mutateAsync({
              id: project.id,
              data: { kind: newKind },
            });
          },
        },
      }),
      createCurrencyColumn(columnHelper, "costEstimate", {
        header: "Estimate",
        mobile: { slot: "meta", priority: 30, interactive: true },
        editable: {
          onSave: async (newEstimate, project) => {
            await updateProjectMutation.mutateAsync({
              id: project.id,
              data: { costEstimate: newEstimate },
            });
          },
        },
      }),
      columnHelper.accessor("locations", {
        id: "locations",
        header: "Location",
        enableSorting: false,
        meta: { className: "w-40", mobile: { slot: "meta", priority: 40 } },
        cell: ({ getValue }) => {
          const locs = getValue();
          if (locs.length === 0) return <NoneValue />;
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
      }),
      columnHelper.accessor((row) => row.rollup.spent, {
        id: "actual",
        header: "Actual",
        enableSorting: true,
        meta: { numeric: true, className: "w-24" },
        cell: ({ row }) => {
          const actual = row.original.rollup.spent;
          if (actual === 0) return <NoneValue />;
          const est = row.original.costEstimate;
          const over = est != null && est > 0 && actual > est;
          return (
            <span
              className={
                over ? "font-medium text-destructive" : "text-positive"
              }
            >
              {formatCurrency(actual, 0)}
            </span>
          );
        },
      }),
      createPlainDateColumn(columnHelper, "startDate", {
        header: "Start",
        className: "w-28",
        mobile: { slot: "meta", priority: 50 },
        editable: {
          onSave: async (newStartDate, project) => {
            await updateProjectMutation.mutateAsync({
              id: project.id,
              data: { startDate: newStartDate },
            });
          },
        },
      }),
      createPlainDateColumn(columnHelper, "endDate", {
        header: "End",
        className: "w-28",
        mobile: { slot: "meta", priority: 60 },
        editable: {
          onSave: async (newEndDate, project) => {
            await updateProjectMutation.mutateAsync({
              id: project.id,
              data: { endDate: newEndDate },
            });
          },
        },
      }),
    ],
    [columnHelper],
  );

  const filters = useMemo(
    () => [
      { id: "name", placeholder: "Search projects..." },
      {
        id: "status",
        placeholder: "Filter by status...",
        filterType: "select" as const,
        options: PROJECT_STATUS_OPTIONS,
      },
      {
        id: "kind",
        placeholder: "Filter by kind...",
        filterType: "select" as const,
        options: PROJECT_KIND_FILTER_OPTIONS,
      },
    ],
    [],
  );

  // defaultSortState always defaults to desc — matches the original
  // ProjectTable's `sorting: [{ id: "startDate", desc: true }]`.
  const tableStateOptions = useMemo(() => ({ initialSort: "startDate" }), []);
  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview("project");

  const {
    table,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
  } = useEntityList({
    entity: "project",
    queryOptions: api.project.list.queryOptions,
    buildFilters: (ts) => ({
      search: ts.getColumnFilter("name"),
      status: ts.getColumnFilter("status") as ProjectStatus | undefined,
      kind: ts.getColumnFilter("kind") as ProjectKind | undefined,
    }),
    columns,
    filters,
    deletable: deletableConfig,
    nameEditable,
    infinite: true,
    tableStateOptions,
  });

  return (
    <div>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Projects Table"
        timing={timing}
        entity="project"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        bulkActionBar={bulkActionBar}
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
      />
      <PreviewSheet />
      {deleteDialog}
    </div>
  );
}
