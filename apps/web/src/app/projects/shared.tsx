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
import { EditableCell } from "~/app/_components/data-table/editable-cell";
import RTable from "~/app/_components/data-table/Table";
import { useClientEntityList } from "~/app/_components/hooks/useClientEntityList";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
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
import {
  projectMutationInvalidateKeys,
  purchaseMutationInvalidateKeys,
  taskMutationInvalidateKeys,
} from "~/lib/query-keys";
import { buildSelectOptions } from "~/lib/select-options";
import { getStatusBadgeProps } from "~/lib/status-colors";
import { cn, formatCurrency } from "~/lib/utils";
import {
  capitalize,
  PROJECT_STATUS_LABELS,
  TRADE_LABELS,
} from "./project-formatting";
import { projectKindOptions } from "./project-options";
import { buildProjectTree, type ProjectTreeRow } from "./project-tree";

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

/**
 * Column config here mirrors tasklist.tsx's (the `/tasks` index page)
 * status/project/trade/dueDate columns — this embedded table can't share that
 * hook (it renders a caller-supplied array with no server pagination/filters
 * of its own via `useEntityList`), so the small duplication is accepted rather
 * than forcing a shared abstraction. Keep both in sync if the editable field
 * set changes; see the reciprocal comment there.
 */
export function TaskList({
  tasks,
  showProjectColumn = true,
}: {
  tasks: TaskOut[];
  /**
   * The Project column is the inline move-to-sub-project affordance — useful
   * when rows span a subtree, but pure noise on a leaf project's detail page
   * where every row is the same project. Callers pass `false` there.
   */
  showProjectColumn?: boolean;
}) {
  const api = useTRPC();

  const updateTaskMutation = useUpdateMutation({
    mutationFn: api.task.update.mutationOptions,
    entity: "task",
    invalidateKeys: taskMutationInvalidateKeys,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: updateTaskMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
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
        editable: {
          onSave: async (newStatus, task) => {
            await updateTaskMutation.mutateAsync({
              id: task.id,
              data: { status: newStatus },
            });
          },
        },
      }),
      taskHelper.accessor("name", {
        header: "Task",
        cell: ({ row }) => row.original.name,
        enableSorting: true,
      }),
      // The inline move-to-sub-project affordance — omitted on leaf projects
      // where every row shares the one project (see `showProjectColumn`).
      ...(showProjectColumn
        ? [
            createProjectLinkColumn(taskHelper, {
              className: "w-40",
              editable: {
                onSave: async (newProjectId, task) => {
                  await updateTaskMutation.mutateAsync({
                    id: task.id,
                    data: { projectId: newProjectId },
                  });
                },
              },
            }),
          ]
        : []),
      createFilterableSelectColumn(taskHelper, "trade", {
        header: "Trade",
        className: "w-32",
        placeholder: "Filter by trade...",
        selectOptions: tradeOptions,
        renderCell: (trade: Trade | null) =>
          trade ? <TradeBadge trade={trade} /> : null,
        editable: {
          onSave: async (newTrade, task) => {
            // Required field — a cleared select is a no-op, not a null write.
            if (!newTrade) return;
            await updateTaskMutation.mutateAsync({
              id: task.id,
              data: { trade: newTrade },
            });
          },
        },
      }),
      createPlainDateColumn(taskHelper, "dueDate", {
        header: "Due",
        className: "w-28",
        editable: {
          onSave: async (newDueDate, task) => {
            await updateTaskMutation.mutateAsync({
              id: task.id,
              data: { dueDate: newDueDate },
            });
          },
        },
      }),
    ],
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

/**
 * Editable-select options for the embedded purchases table's Future/Status
 * column — same "true"/"false" values as the index page's `futureFilterOptions`
 * (~/app/purchases/purchase-options), but "Actual" rather than "Already made"
 * to match this column's tighter "Status" header. Module-level: a stable
 * reference for the column's `useMemo`.
 */
const futureEditOptions: FilterableComboboxItem[] = [
  { value: "false", label: "Actual" },
  { value: "true", label: "Planned" },
];

/**
 * Column config here mirrors purchaselist.tsx's (the `/purchases` index page)
 * cost/date/costType/trade/project/future columns — this embedded table can't
 * share that hook (it renders a caller-supplied array with no server
 * pagination/filters of its own via `useEntityList`), so the small
 * duplication is accepted rather than forcing a shared abstraction. Keep both
 * in sync if the editable field set changes; see the reciprocal comment
 * there.
 */
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
  /**
   * The Project column is the inline move-to-sub-project affordance — noise on
   * a leaf project's detail page where every row is the same project. Callers
   * pass `false` there.
   */
  showProjectColumn?: boolean;
}) {
  const api = useTRPC();

  const updatePurchaseMutation = useUpdateMutation({
    mutationFn: api.purchase.update.mutationOptions,
    entity: "purchase",
    invalidateKeys: purchaseMutationInvalidateKeys,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: updatePurchaseMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
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
      // The inline move-to-sub-project affordance — omitted on leaf projects
      // where every row shares the one project (see `showProjectColumn`).
      ...(showProjectColumn
        ? [
            createProjectLinkColumn(purchaseHelper, {
              className: "w-40",
              editable: {
                onSave: async (newProjectId, purchase) => {
                  await updatePurchaseMutation.mutateAsync({
                    id: purchase.id,
                    data: { projectId: newProjectId },
                  });
                },
              },
            }),
          ]
        : []),
      createFilterableSelectColumn(purchaseHelper, "costType", {
        header: "Cost Type",
        className: "w-28",
        placeholder: "Filter by cost type...",
        selectOptions: costTypeOptions,
        renderCell: (costType: CostType | null) =>
          costType ? costTypeLabels[costType] : <NoneValue />,
        editable: {
          onSave: async (newCostType, purchase) => {
            // Required field — a cleared select is a no-op, not a null write.
            if (!newCostType) return;
            await updatePurchaseMutation.mutateAsync({
              id: purchase.id,
              data: { costType: newCostType },
            });
          },
        },
      }),
      {
        ...createFilterableSelectColumn(purchaseHelper, "trade", {
          header: "Trade",
          className: "w-32",
          placeholder: "Filter by trade...",
          selectOptions: tradeOptions,
          renderCell: (trade: Trade | null) =>
            trade ? <TradeBadge trade={trade} /> : null,
          editable: {
            onSave: async (newTrade, purchase) => {
              // Required field — a cleared select is a no-op, not a null write.
              if (!newTrade) return;
              await updatePurchaseMutation.mutateAsync({
                id: purchase.id,
                data: { trade: newTrade },
              });
            },
          },
        }),
        // Exact-match so the pivot's controlled `trade` filter selects one
        // trade (the default `includesString` would over-match substrings).
        // `createFilterableSelectColumn` doesn't expose a `filterFn` option,
        // so this overrides it on the returned column def — load-bearing,
        // don't drop it.
        filterFn: "equalsString" as const,
      },
      purchaseHelper.accessor("cost", {
        header: "Cost",
        enableSorting: true,
        meta: { numeric: true, className: "w-20" },
        cell: (info) => {
          const cost = info.getValue();
          const purchase = info.row.original;
          return (
            <EditableCell
              value={cost}
              onSave={async (newCost) => {
                await updatePurchaseMutation.mutateAsync({
                  id: purchase.id,
                  data: { cost: newCost },
                });
              }}
              config={{ type: "currency" }}
              renderValue={(v) => {
                if (v == null) return null;
                // Negative rows are credits/contributions (money in) — tint
                // them so they don't read as spend. `createCurrencyColumn`
                // can't express this per-value tint (its editable
                // `renderValue` is fixed), so this stays a custom column that
                // mirrors its `EditableCell` composition instead.
                return (
                  <span className={cn("font-medium", v < 0 && "text-positive")}>
                    {formatCurrency(v, 0)}
                  </span>
                );
              }}
            />
          );
        },
      }),
      createPlainDateColumn(purchaseHelper, "date", {
        header: "Date",
        className: "w-28",
        editable: {
          onSave: async (newDate, purchase) => {
            await updatePurchaseMutation.mutateAsync({
              id: purchase.id,
              data: { date: newDate },
            });
          },
        },
      }),
      purchaseHelper.accessor((row) => (row.future ? "true" : "false"), {
        id: "future",
        header: "Status",
        enableSorting: false,
        meta: { className: "w-24" },
        cell: (info) => {
          const purchase = info.row.original;
          return (
            <EditableCell
              value={info.getValue()}
              onSave={async (newVal) => {
                await updatePurchaseMutation.mutateAsync({
                  id: purchase.id,
                  data: { future: newVal === "true" },
                });
              }}
              config={{ type: "select", options: futureEditOptions }}
              renderValue={(v) =>
                v === "true" ? (
                  <Badge variant="warning">Planned</Badge>
                ) : (
                  <NoneValue />
                )
              }
            />
          );
        },
      }),
    ],
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
 * Renders through `useClientEntityList` over the dashboard's
 * already-fetched-and-chip-filtered `projects` array — no query of its own.
 * `buildProjectTree` nests sub-projects under their parent (WBS shape) so the
 * table's rows mirror the project hierarchy instead of a flat list, with
 * `useClientEntityList`'s `tree` option wiring TanStack's expand/collapse.
 *
 * This replaces an earlier design that ran its own independent `project.list`
 * query specifically to get server-backed infinite scroll, inline editing,
 * and delete — trading away visibility into the dashboard's status/kind/
 * location chip filters to get them (the table had its own separate inline
 * status/kind column filters instead). Now that `useClientEntityList` gives
 * inline editing + delete over caller-supplied data, that trade-off is gone:
 * the table always reflects exactly what the dashboard's chips show. Column
 * filtering for status/kind moved to the dashboard's chips (`DashboardFilters`)
 * — only the name search box remains local to this table.
 */
export function ProjectTable({
  projects,
  onRowClick,
  onRowHover,
  PreviewSheet,
}: {
  projects: ProjectOut[];
  onRowClick: (row: TableRow<ProjectTreeRow>) => void;
  onRowHover: (row: TableRow<ProjectTreeRow>) => void;
  PreviewSheet: ComponentType;
}) {
  const api = useTRPC();
  // Columns are helper'd over `ProjectTreeRow`, not `ProjectOut`: the client
  // hook's rows are `ProjectOut & { subRows }`, and TanStack's `ColumnDef` is
  // invariant in `TData`, so a `ProjectOut`-helper wouldn't typecheck against
  // `useClientEntityList`'s table. `ProjectTreeRow` is a structural supertype
  // of `ProjectOut` (every accessor below only reads `ProjectOut` fields), so
  // this is a pure type-parameter swap — no behavior change.
  const columnHelper = useMemo(() => createColumnHelper<ProjectTreeRow>(), []);

  const treeData = useMemo(() => buildProjectTree(projects), [projects]);

  const updateProjectMutation = useUpdateMutation({
    mutationFn: api.project.update.mutationOptions,
    entity: "project",
    invalidateKeys: projectMutationInvalidateKeys,
  });

  const nameEditable = useNameEditable<ProjectTreeRow>(
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
      columnHelper.accessor(
        (row) =>
          row.rollup.subtree.projectCount > 0
            ? row.rollup.subtree.actualSpent
            : row.rollup.actualSpent,
        {
          id: "actual",
          header: "Actual",
          enableSorting: true,
          meta: { numeric: true, className: "w-24" },
          cell: ({ row }) => {
            const { rollup, costEstimate } = row.original;
            const hasSubtree = rollup.subtree.projectCount > 0;
            // `actualSpent` = money already out (excludes planned/future +
            // negative contributions), matching the detail hero's "Actual" so
            // this column never means something the hero doesn't. subtree
            // aggregates are over LIVE descendants — not the currently
            // chip-filtered `projects` view (same caveat as
            // spending-by-project.tsx): a filtered-out child's spend still
            // rolls up into its visible parent's "Actual" here.
            const actual = hasSubtree
              ? rollup.subtree.actualSpent
              : rollup.actualSpent;
            if (actual === 0) return <NoneValue />;
            const est = hasSubtree
              ? (rollup.subtree.costEstimate ?? costEstimate)
              : costEstimate;
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
        },
      ),
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

  // Status/kind/location filtering now lives in the dashboard's chips — only
  // the name search stays as a local column filter.
  const filters = useMemo(
    () => [{ id: "name", placeholder: "Search projects..." }],
    [],
  );

  // defaultSortState always defaults to desc — matches the original
  // ProjectTable's `sorting: [{ id: "startDate", desc: true }]`.
  const tableStateOptions = useMemo(() => ({ initialSort: "startDate" }), []);
  const { table, bulkActionBar, deleteDialog } = useClientEntityList({
    entity: "project",
    data: treeData,
    columns,
    filters,
    deletable: deletableConfig,
    nameEditable,
    nameSuffix: subProjectCountSuffix,
    tableStateOptions,
    tree: {
      getSubRows: (row) => row.subRows,
      expandable: true,
      filterFromLeafRows: true,
      paginateExpandedRows: false,
      autoResetExpanded: false,
    },
  });

  // Auto-expand the whole tree while a name search is active, so a match
  // nested several levels deep in the WBS is actually visible; collapse back
  // once the search is cleared. Edge-triggered on `searching` alone (not
  // every keystroke, and not on `table`, which is otherwise a stable ref) so
  // this doesn't fight a user who manually expanded/collapsed specific rows
  // mid-search.
  const searching = Boolean(table.getColumn("name")?.getFilterValue());
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally edge-triggered on `searching` only — see comment above
  useEffect(() => {
    table.toggleAllRowsExpanded(searching);
  }, [searching]);

  return (
    <div>
      <RTable
        table={table}
        ariaLabel="Projects Table"
        entity="project"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        bulkActionBar={bulkActionBar}
      />
      <PreviewSheet />
      {deleteDialog}
    </div>
  );
}
