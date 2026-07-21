import {
  type CostType,
  type ProjectKind,
  type ProjectOut,
  type ProjectStatus,
  type PurchaseOut,
  projectStatusValues,
  type TaskOut,
  type TaskStatus,
  type Trade,
  tradeValues,
} from "@cubby/schemas/project";
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type Row as TableRow,
  useReactTable,
} from "@tanstack/react-table";
import { partition } from "es-toolkit";
import {
  Archive,
  Car,
  ClipboardList,
  Droplets,
  ExternalLink,
  Fan,
  Grid3x3,
  Hammer,
  ListTodo,
  type LucideIcon,
  PaintRoller,
  Palette,
  RectangleHorizontal,
  Refrigerator,
  Ruler,
  Shapes,
  ShoppingCart,
  Square,
  Trash2,
  Trees,
  Truck,
  Wrench,
  Zap,
} from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useMemo } from "react";
import {
  createCurrencyColumn,
  createFilterableSelectColumn,
  createPlainDateColumn,
  createProjectLinkColumn,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import {
  costTypeLabels,
  costTypeOptions,
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
import {
  capitalize,
  PROJECT_STATUS_LABELS,
  TRADE_LABELS,
} from "./project-formatting";
import { projectKindOptions } from "./project-options";

/**
 * Human-facing labels for the raw DB enum values (`@cubby/schemas/project`).
 * Single source of truth for status column headers, badges, and filter chips
 * across the dashboard/detail page/charts — never string-match the raw enum
 * value for display text.
 */
// Task labels live with the task options (see the note there on import
// direction); re-exported here for this file's many existing consumers.
export { TASK_STATUS_LABELS } from "~/app/tasks/task-options";
export {
  capitalize,
  formatDate,
  formatDateRange,
  monthKey,
  monthLabel,
  normalizeCostTypeKey,
  PROJECT_STATUS_LABELS,
  TRADE_LABELS,
} from "./project-formatting";

/** Status select options for the detail page's inline `EditableCell` status field. */
export const PROJECT_STATUS_OPTIONS: FilterableComboboxItem[] =
  buildSelectOptions(projectStatusValues, PROJECT_STATUS_LABELS);

// -- Cost-type colors --

export { getCostTypeColor } from "~/lib/status-colors";

/**
 * Monochrome Lucide glyph per trade — a scannable leading mark for badges and
 * select rows. Icons live here (client) rather than in `@cubby/schemas` so the
 * schema package stays presentation-free. Full-color emoji were deliberately
 * dropped in the Notion migration; these `currentColor` glyphs sit on the
 * Warm-Paper Ledger without the glossy clash.
 */
const TRADE_ICONS: Record<Trade, LucideIcon> = {
  planning: ClipboardList,
  demolition: Trash2,
  building: Hammer,
  drywall: Square,
  electrical: Zap,
  plumbing: Droplets,
  mechanical: Fan,
  cabinetry: Archive,
  countertop: RectangleHorizontal,
  flooring: Grid3x3,
  millwork: Ruler,
  finishes: PaintRoller,
  appliances: Refrigerator,
  landscaping: Trees,
  logistics: Truck,
  metalworking: Wrench,
  crafts: Palette,
  auto: Car,
  other: Shapes,
};

/** Outline badge with the trade's leading glyph + label — the canonical trade chip. */
export function TradeBadge({ trade }: { trade: Trade }) {
  const Icon = TRADE_ICONS[trade];
  return (
    <Badge variant="outline">
      <Icon />
      {TRADE_LABELS[trade]}
    </Badge>
  );
}

/**
 * Bare trade glyph — the same icon as `TradeBadge` without the pill, for tight
 * spots like the Gantt name pane where the label is already present.
 */
export function TradeIcon({
  trade,
  className,
}: {
  trade: Trade;
  className?: string;
}) {
  const Icon = TRADE_ICONS[trade];
  return <Icon className={className} aria-label={TRADE_LABELS[trade]} />;
}

/**
 * `{value,label,icon}` options for the trade filter/inline-edit select — shared
 * by tasks and purchases. Not `buildSelectOptions` because that helper carries
 * no icon; the glyph mirrors `TradeBadge` so the select and the chip match.
 */
export const tradeOptions: FilterableComboboxItem[] = tradeValues.map(
  (value) => {
    const Icon = TRADE_ICONS[value];
    return {
      value,
      label: TRADE_LABELS[value],
      icon: <Icon className="size-3.5 text-muted-foreground" />,
    };
  },
);
// -- Chart theme (consistent across all Nivo charts) --

export {
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
} from "~/lib/nivo-theme";

// -- Status Icon --

export function StatusIcon({ status }: { status: ProjectStatus | TaskStatus }) {
  const { icon: Icon, className } = getStatusBadgeProps("project", status);
  // Extract just the text color from the bg+text className tuple.
  const textClass =
    className.split(" ").find((c) => c.startsWith("text-")) ??
    "text-muted-foreground";
  return Icon ? <Icon className={cn("h-4 w-4 shrink-0", textClass)} /> : null;
}

// -- Task Table --

const taskHelper = createColumnHelper<TaskOut>();

// The project link column is redundant on a leaf project's detail page (every
// row links back to the project you're already on), so it's opt-out via
// `showProjectColumn`.
const buildTaskColumns = (showProjectColumn: boolean) => [
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
  ...(showProjectColumn
    ? [createProjectLinkColumn(taskHelper, { className: "w-40" })]
    : []),
  taskHelper.accessor("trade", {
    header: "Trade",
    cell: ({ getValue }) => {
      const trade = getValue();
      if (!trade) return null;
      return <TradeBadge trade={trade} />;
    },
    enableSorting: true,
  }),
  createPlainDateColumn(taskHelper, "dueDate", {
    header: "Due",
    className: "w-28",
  }),
];

export function TaskList({
  tasks,
  showProjectColumn = true,
}: {
  tasks: TaskOut[];
  showProjectColumn?: boolean;
}) {
  const columns = useMemo(
    () => buildTaskColumns(showProjectColumn),
    [showProjectColumn],
  );
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
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: (row) => row.id,
    initialState: {
      pagination: { pageSize: 25 },
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

  return <RTable table={table} embedded />;
}

// -- Purchase Table --

const purchaseHelper = createColumnHelper<PurchaseOut>();

const buildPurchaseColumns = (showProjectColumn: boolean) => [
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
  ...(showProjectColumn
    ? [createProjectLinkColumn(purchaseHelper, { className: "w-40" })]
    : []),
  createFilterableSelectColumn(purchaseHelper, "costType", {
    header: "Cost Type",
    className: "w-28",
    placeholder: "Filter by cost type...",
    selectOptions: costTypeOptions,
    renderCell: (costType: CostType | null) =>
      costType ? costTypeLabels[costType] : <NoneValue />,
  }),
  purchaseHelper.accessor("trade", {
    header: "Trade",
    // Exact-match so the pivot's controlled `trade` filter selects one trade
    // (the default `includesString` would over-match substrings).
    filterFn: "equalsString",
    cell: ({ getValue }) => {
      const trade = getValue();
      if (!trade) return null;
      return <TradeBadge trade={trade} />;
    },
    enableSorting: true,
  }),
  purchaseHelper.accessor("cost", {
    header: "Cost",
    cell: ({ getValue }) => {
      const cost = getValue();
      if (cost == null) return null;
      // Negative rows are credits/contributions (money in) — tint them so they
      // don't read as spend.
      return (
        <span className={cn("font-medium", cost < 0 && "text-positive")}>
          {formatCurrency(cost, 0)}
        </span>
      );
    },
    enableSorting: true,
  }),
  createPlainDateColumn(purchaseHelper, "date", {
    header: "Date",
    className: "w-28",
  }),
];

export function PurchaseList({
  purchases,
  tradeFilter,
  costTypeFilter,
  showProjectColumn = true,
}: {
  purchases: PurchaseOut[];
  /** Controlled column filters, driven by the Trade × Cost Type pivot click. */
  tradeFilter?: Trade | null;
  costTypeFilter?: CostType | null;
  showProjectColumn?: boolean;
}) {
  const columns = useMemo(
    () => buildPurchaseColumns(showProjectColumn),
    [showProjectColumn],
  );
  const table = useReactTable({
    data: purchases,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: (row) => row.id,
    initialState: {
      pagination: { pageSize: 25 },
    },
  });

  // Mirror the pivot's active cell onto the table's column filters. The
  // pivot cost keys ARE `CostType`, so values pass straight through.
  useEffect(() => {
    table.getColumn("trade")?.setFilterValue(tradeFilter ?? undefined);
    table.getColumn("costType")?.setFilterValue(costTypeFilter ?? undefined);
  }, [table, tradeFilter, costTypeFilter]);

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

  return <RTable table={table} embedded />;
}

// -- Project Table --

const PROJECT_KIND_FILTER_OPTIONS: FilterableComboboxItem[] = [
  { value: "", label: "All kinds" },
  ...projectKindOptions,
];

/**
 * `N sub` chip after a parent project's name. Module-level because
 * `nameSuffix` sits in useStandardColumns' columns-`useMemo` dependency array
 * — an inline arrow would churn the memo every render.
 */
const subProjectCountSuffix = (row: ProjectOut): ReactNode =>
  row.childProjectIds.length > 0 ? (
    <Badge variant="outline">{row.childProjectIds.length} sub</Badge>
  ) : undefined;

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
export function ProjectTable({
  onRowClick,
  onRowHover,
  PreviewSheet,
}: {
  onRowClick: (row: TableRow<ProjectOut>) => void;
  onRowHover: (row: TableRow<ProjectOut>) => void;
  PreviewSheet: ComponentType;
}) {
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
      // Sub-projects are managed from their parent's detail page, not
      // surfaced as independent rows here.
      topLevelOnly: true,
    }),
    columns,
    filters,
    deletable: deletableConfig,
    nameEditable,
    nameSuffix: subProjectCountSuffix,
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
