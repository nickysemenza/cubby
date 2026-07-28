import type {
  CostType,
  ProjectKind,
  ProjectOut,
  ProjectStatus,
  PurchaseOut,
  TaskOut,
  TaskStatus,
  Trade,
} from "@cubby/schemas/project";
import {
  type ColumnHelper,
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
  ArrowRightLeft,
  ExternalLink,
  ListChecks,
  ListTodo,
  ShoppingCart,
  Tag,
  Wrench,
} from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BulkActionBar } from "~/app/_components/data-table/BulkActionBar";
import {
  selectCellData,
  specFromCellData,
} from "~/app/_components/data-table/cell-data";
import {
  createCurrencyColumn,
  createFilterableSelectColumn,
  createPlainDateColumn,
  createProjectLinkColumn,
  type FilterConfig,
  type MobileColumnMeta,
} from "~/app/_components/data-table/columnHelpers";
import { EditableCell } from "~/app/_components/data-table/editable-cell";
import { buildSelectColumn } from "~/app/_components/data-table/row-selection";
import RTable from "~/app/_components/data-table/Table";
import { useBulkActions } from "~/app/_components/data-table/useBulkActions";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useClientEntityList } from "~/app/_components/hooks/useClientEntityList";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { MoveToProjectDialog } from "~/app/_components/tracker/move-to-project-dialog";
import { SetFieldDialog } from "~/app/_components/tracker/set-field-dialog";
import { SetTaskStatusDialog } from "~/app/_components/tracker/set-task-status-dialog";
import {
  costTypeBadgeVariant,
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
import { manifestFilterConfig } from "~/entities/filter-manifest";
import { useTRPC } from "~/integrations/trpc/react";
import {
  projectMutationInvalidateKeys,
  purchaseMutationInvalidateKeys,
  taskMutationInvalidateKeys,
} from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { getStatusBadgeProps } from "~/lib/status-colors";
import { cn, formatCurrency } from "~/lib/utils";
import { capitalize, PROJECT_STATUS_LABELS } from "./project-formatting";
import { PROJECT_STATUS_OPTIONS, projectKindOptions } from "./project-options";
import { buildProjectTree, type ProjectTreeRow } from "./project-tree";
import { TradeBadge, tradeOptions } from "./trade-options";

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

export { PROJECT_STATUS_OPTIONS } from "./project-options";

// -- Cost-type colors --

export { getCostTypeColor } from "~/lib/status-colors";

// Trade glyphs / chips / select options moved to `./trade-options` so the
// filter manifest can import `tradeOptions` without closing an import cycle
// back through this file's tables. Re-exported so consumers don't care.
export { TradeBadge, TradeIcon, tradeOptions } from "./trade-options";

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
  return Icon ? <Icon className={cn("size-4 shrink-0", textClass)} /> : null;
}

// -- Task Table --

const taskHelper = createColumnHelper<TaskOut>();

// --- Shared task/purchase column factories ---
// These bake the renderCell + select options + editable field-mapping shared by
// the `/tasks` & `/purchases` index pages (tasklist.tsx / purchaselist.tsx, via
// `useEntityList`) and the embedded tables below (raw `useReactTable` over a
// caller-supplied array). Each returns ONE column def; callers pass their own
// `mobile` / `filterConfig` / density knobs. The project column already has its
// own shared factory (`createProjectLinkColumn`); the name column differs per
// caller, so both are left inline.

/** Status column — badge render + `status` write. */
export function taskStatusColumn(
  helper: ColumnHelper<TaskOut>,
  save: (status: TaskStatus, task: TaskOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta },
) {
  return createFilterableSelectColumn(helper, "status", {
    header: "Status",
    className: "w-32",
    placeholder: "Filter by status...",
    selectOptions: taskStatusOptions,
    filterConfig: manifestFilterConfig("task", "status"),
    renderCell: (status: TaskStatus) => (
      <Badge variant={taskStatusBadgeVariant[status]}>
        {TASK_STATUS_LABELS[status]}
      </Badge>
    ),
    mobile: opts?.mobile,
    editable: {
      onSave: async (newStatus, task) => {
        await save(newStatus, task);
      },
    },
  });
}

/** Trade column — glyph badge + required `trade` write. `emptyAsNull` renders an
 * empty cell (embedded tables) instead of the muted dash (index pages). */
export function taskTradeColumn(
  helper: ColumnHelper<TaskOut>,
  save: (trade: Trade, task: TaskOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta; emptyAsNull?: boolean },
) {
  return createFilterableSelectColumn(helper, "trade", {
    header: "Trade",
    className: "w-32",
    placeholder: "Filter by trade...",
    selectOptions: tradeOptions,
    filterConfig: manifestFilterConfig("task", "trade"),
    renderCell: (trade: Trade | null) =>
      trade ? (
        <TradeBadge trade={trade} />
      ) : opts?.emptyAsNull ? null : (
        <NoneValue />
      ),
    mobile: opts?.mobile,
    editable: {
      onSave: async (newTrade, task) => {
        // Required field — a cleared select is a no-op, not a null write.
        if (!newTrade) return;
        await save(newTrade, task);
      },
    },
  });
}

/** Due-date column — inline date-picker + `dueDate` write. */
export function taskDueColumn(
  helper: ColumnHelper<TaskOut>,
  save: (dueDate: string | null, task: TaskOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta },
) {
  return createPlainDateColumn(helper, "dueDate", {
    header: "Due",
    className: "w-28",
    mobile: opts?.mobile,
    editable: {
      onSave: async (newDueDate, task) => {
        await save(newDueDate, task);
      },
    },
  });
}

/**
 * The embedded task table: client-side filter/sort/pagination over a
 * caller-supplied array, deliberately — NOT an unconverted `useEntityList`.
 *
 * These are bounded sub-lists (one project's tasks, already server-scoped
 * and capped by the caller's query), so server pagination would buy nothing at
 * this data scale. More importantly, this component is also rendered by the
 * projects dashboard's Data view, which scopes rows to
 * `!row.projectId || dashboardProjectIds.has(row.projectId)` — an OR that no
 * server filter expresses (`eqAny` gives `inArray`; `noProject` is a separate
 * AND-ed condition), over a project set that only `project.dashboardSummary`'s
 * kind/location chips understand. Converting would mean two data paths in one
 * component, which is how these tables drifted from the index pages before.
 *
 * Columns come from the shared factories above — the same ones the /tasks
 * index page feeds through `useEntityList` — and their filter controls come
 * from the filter manifest via `manifestFilterConfig`, so the embedded and
 * index tables can't diverge even though their data paths differ.
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
  const lastSelectedIdRef = useRef<string | null>(null);
  const shiftKeyRef = useRef(false);
  const [bulkMoveItems, setBulkMoveItems] = useState<TaskOut[]>([]);
  const [bulkStatusItems, setBulkStatusItems] = useState<TaskOut[]>([]);
  const [bulkTradeItems, setBulkTradeItems] = useState<TaskOut[]>([]);

  const updateTaskMutation = useUpdateMutation({
    mutationFn: api.task.update.mutationOptions,
    entity: "task",
    invalidateKeys: taskMutationInvalidateKeys,
  });

  const bulkActions = useMemo(
    () => ({
      actions: [
        {
          id: "move",
          label: "Move to project...",
          icon: <ArrowRightLeft className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: TableRow<TaskOut>[]) => {
            setBulkMoveItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
        {
          id: "set-status",
          label: "Set status...",
          icon: <ListChecks className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: TableRow<TaskOut>[]) => {
            setBulkStatusItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
        {
          id: "set-trade",
          label: "Set trade...",
          icon: <Wrench className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: TableRow<TaskOut>[]) => {
            setBulkTradeItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
      ],
      clearSelectionOnComplete: false,
    }),
    [],
  );
  const bulkActionsState = useBulkActions({ config: bulkActions });

  // biome-ignore lint/correctness/useExhaustiveDependencies: updateTaskMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      buildSelectColumn<TaskOut>(lastSelectedIdRef, shiftKeyRef),
      taskStatusColumn(
        taskHelper,
        async (status, task) => {
          await updateTaskMutation.mutateAsync({
            id: task.id,
            data: { status },
          });
        },
        { mobile: { slot: "subtitle", priority: 10 } },
      ),
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
              mobile: { slot: "meta", priority: 30, interactive: true },
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
      taskTradeColumn(
        taskHelper,
        async (trade, task) => {
          await updateTaskMutation.mutateAsync({
            id: task.id,
            data: { trade },
          });
        },
        { emptyAsNull: true, mobile: { slot: "meta", priority: 50 } },
      ),
      taskDueColumn(
        taskHelper,
        async (dueDate, task) => {
          await updateTaskMutation.mutateAsync({
            id: task.id,
            data: { dueDate },
          });
        },
        { mobile: { slot: "meta", priority: 40, interactive: true } },
      ),
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
    enableRowSelection: true,
    state: { rowSelection: bulkActionsState.rowSelection },
    onRowSelectionChange: bulkActionsState.onRowSelectionChange,
    initialState: {
      pagination: { pageSize: 25 },
    },
  });

  const bulkMoveMutation = useActionMutation({
    mutationFn: api.task.bulkMove.mutationOptions,
    invalidateKeys: taskMutationInvalidateKeys,
    success: (data) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `Moved ${data.items.length} task${data.items.length !== 1 ? "s" : ""}`,
      ),
    onSuccess: () => {
      setBulkMoveItems([]);
      table.resetRowSelection();
    },
  });

  const bulkStatusMutation = useActionMutation({
    mutationFn: api.task.bulkSetStatus.mutationOptions,
    invalidateKeys: taskMutationInvalidateKeys,
    success: (data) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `Updated ${data.items.length} task${data.items.length !== 1 ? "s" : ""}`,
      ),
    onSuccess: () => {
      setBulkStatusItems([]);
      table.resetRowSelection();
    },
  });

  const bulkTradeMutation = useActionMutation({
    mutationFn: api.task.bulkSetTrade.mutationOptions,
    invalidateKeys: taskMutationInvalidateKeys,
    success: (data) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `Updated ${data.items.length} task${data.items.length !== 1 ? "s" : ""}`,
      ),
    onSuccess: () => {
      setBulkTradeItems([]);
      table.resetRowSelection();
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

  const bulkActionBar =
    bulkActionsState.selectedCount > 0 ? (
      <BulkActionBar
        selectedCount={bulkActionsState.selectedCount}
        selectedRows={table.getFilteredSelectedRowModel().rows}
        actions={bulkActionsState.getAvailableActions(
          table.getFilteredSelectedRowModel().rows,
        )}
        onExecute={bulkActionsState.executeAction}
        onClearSelection={bulkActionsState.clearSelection}
        isExecuting={bulkActionsState.isExecuting}
        currentAction={bulkActionsState.currentAction}
      />
    ) : null;

  return (
    <>
      <RTable table={table} embedded bulkActionBar={bulkActionBar} />
      {bulkMoveItems.length > 0 && (
        <MoveToProjectDialog
          open={bulkMoveItems.length > 0}
          onOpenChange={(open) => {
            if (!open) setBulkMoveItems([]);
          }}
          items={bulkMoveItems}
          entityLabel="Task"
          isPending={bulkMoveMutation.isPending}
          onConfirm={async (projectId) => {
            await bulkMoveMutation.mutateAsync({
              ids: bulkMoveItems.map((t) => t.id),
              projectId,
            });
          }}
        />
      )}
      {bulkStatusItems.length > 0 && (
        <SetTaskStatusDialog
          open={bulkStatusItems.length > 0}
          onOpenChange={(open) => {
            if (!open) setBulkStatusItems([]);
          }}
          items={bulkStatusItems}
          isPending={bulkStatusMutation.isPending}
          onConfirm={async (status) => {
            await bulkStatusMutation.mutateAsync({
              ids: bulkStatusItems.map((t) => t.id),
              status,
            });
          }}
        />
      )}
      {bulkTradeItems.length > 0 && (
        <SetFieldDialog
          open={bulkTradeItems.length > 0}
          onOpenChange={(open) => {
            if (!open) setBulkTradeItems([]);
          }}
          items={bulkTradeItems}
          isPending={bulkTradeMutation.isPending}
          options={tradeOptions}
          fieldLabel="Trade"
          itemNoun="Task"
          onConfirm={async (trade) => {
            await bulkTradeMutation.mutateAsync({
              ids: bulkTradeItems.map((t) => t.id),
              trade: trade as Trade,
            });
          }}
        />
      )}
    </>
  );
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

// --- Shared purchase column factories (see the task factories above) ---

/** Cost-type column — label render + required `costType` write. */
export function purchaseCostTypeColumn(
  helper: ColumnHelper<PurchaseOut>,
  save: (costType: CostType, purchase: PurchaseOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta },
) {
  return createFilterableSelectColumn(helper, "costType", {
    header: "Cost Type",
    className: "w-28",
    placeholder: "Filter by cost type...",
    selectOptions: costTypeOptions,
    filterConfig: manifestFilterConfig("purchase", "costType"),
    renderCell: (costType: CostType | null) =>
      costType ? (
        <Badge variant={costTypeBadgeVariant[costType]}>
          {costTypeLabels[costType]}
        </Badge>
      ) : (
        <NoneValue />
      ),
    mobile: opts?.mobile,
    editable: {
      onSave: async (newCostType, purchase) => {
        // Required field — a cleared select is a no-op, not a null write.
        if (!newCostType) return;
        await save(newCostType, purchase);
      },
    },
  });
}

/** Trade column — glyph badge + required `trade` write. `exactFilter` sets
 * `filterFn: "equalsString"` (the pivot's controlled trade filter must select
 * one trade, not substring-match); `emptyAsNull` renders an empty cell instead
 * of the muted dash. */
export function purchaseTradeColumn(
  helper: ColumnHelper<PurchaseOut>,
  save: (trade: Trade, purchase: PurchaseOut) => Promise<void>,
  opts?: {
    mobile?: MobileColumnMeta;
    emptyAsNull?: boolean;
    exactFilter?: boolean;
  },
) {
  const column = createFilterableSelectColumn(helper, "trade", {
    header: "Trade",
    className: "w-32",
    placeholder: "Filter by trade...",
    selectOptions: tradeOptions,
    filterConfig: manifestFilterConfig("purchase", "trade"),
    renderCell: (trade: Trade | null) =>
      trade ? (
        <TradeBadge trade={trade} />
      ) : opts?.emptyAsNull ? null : (
        <NoneValue />
      ),
    mobile: opts?.mobile,
    editable: {
      onSave: async (newTrade, purchase) => {
        // Required field — a cleared select is a no-op, not a null write.
        if (!newTrade) return;
        await save(newTrade, purchase);
      },
    },
  });
  // `createFilterableSelectColumn` doesn't expose a `filterFn` option, so the
  // exact-match override is applied on the returned column def — load-bearing
  // for the pivot's single-trade selection, don't drop it.
  return opts?.exactFilter
    ? { ...column, filterFn: "equalsString" as const }
    : column;
}

/** Cost column — `decimals`/`signedTone` tune the embedded whole-dollar,
 * sign-tinted look; the index page omits them for default cents + flat green. */
export function purchaseCostColumn(
  helper: ColumnHelper<PurchaseOut>,
  save: (cost: number | null, purchase: PurchaseOut) => Promise<void>,
  opts?: {
    className?: string;
    mobile?: MobileColumnMeta;
    decimals?: number;
    signedTone?: boolean;
  },
) {
  return createCurrencyColumn(helper, "cost", {
    header: "Cost",
    className: opts?.className,
    mobile: opts?.mobile,
    decimals: opts?.decimals,
    signedTone: opts?.signedTone,
    editable: {
      onSave: async (newCost, purchase) => {
        await save(newCost, purchase);
      },
    },
  });
}

/** Date column — inline date-picker + `date` write. */
export function purchaseDateColumn(
  helper: ColumnHelper<PurchaseOut>,
  save: (date: string | null, purchase: PurchaseOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta; filterConfig?: FilterConfig },
) {
  return createPlainDateColumn(helper, "date", {
    header: "Date",
    className: "w-28",
    mobile: opts?.mobile,
    filterConfig: opts?.filterConfig,
    editable: {
      onSave: async (newDate, purchase) => {
        await save(newDate, purchase);
      },
    },
  });
}

/** Future/Status column — the editable "Actual"/"Planned" select over the
 * boolean `future` field. */
export function purchaseFutureColumn(
  helper: ColumnHelper<PurchaseOut>,
  save: (future: boolean, purchase: PurchaseOut) => Promise<void>,
  opts?: {
    className?: string;
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
  },
) {
  // Shared copy/paste descriptor: the boolean `future` field as a select of
  // "true"/"false". Wiring `meta.cellData` (like the column factories do) makes
  // this the last inline-editable purchase column visible to range copy/paste.
  const cellData = selectCellData<PurchaseOut>(
    (row) => (row.future ? "true" : "false"),
    futureEditOptions,
    (row, value) => save(value === "true", row),
  );
  return helper.accessor((row) => (row.future ? "true" : "false"), {
    id: "future",
    header: "Status",
    enableSorting: false,
    meta: {
      className: opts?.className ?? "w-24",
      mobile: opts?.mobile,
      filterConfig: opts?.filterConfig,
      cellData,
    },
    cell: (info) => {
      const purchase = info.row.original;
      return (
        <EditableCell
          value={info.getValue()}
          onSave={async (newVal) => {
            await save(newVal === "true", purchase);
          }}
          clipboard={specFromCellData(cellData, purchase)}
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
  });
}

/**
 * The embedded purchase table: client-side filter/sort/pagination over a
 * caller-supplied array, deliberately — NOT an unconverted `useEntityList`.
 *
 * These are bounded sub-lists (one project's purchases, already server-scoped
 * and capped by the caller's query), so server pagination would buy nothing at
 * this data scale. More importantly, this component is also rendered by the
 * projects dashboard's Data view, which scopes rows to
 * `!row.projectId || dashboardProjectIds.has(row.projectId)` — an OR that no
 * server filter expresses (`eqAny` gives `inArray`; `noProject` is a separate
 * AND-ed condition), over a project set that only `project.dashboardSummary`'s
 * kind/location chips understand. Converting would mean two data paths in one
 * component, which is how these tables drifted from the index pages before.
 *
 * Columns come from the shared factories above — the same ones the /purchases
 * index page feeds through `useEntityList` — and their filter controls come
 * from the filter manifest via `manifestFilterConfig`, so the embedded and
 * index tables can't diverge even though their data paths differ.
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
  const lastSelectedIdRef = useRef<string | null>(null);
  const shiftKeyRef = useRef(false);
  const [bulkMoveItems, setBulkMoveItems] = useState<PurchaseOut[]>([]);
  const [bulkTradeItems, setBulkTradeItems] = useState<PurchaseOut[]>([]);
  const [bulkCostTypeItems, setBulkCostTypeItems] = useState<PurchaseOut[]>([]);

  const updatePurchaseMutation = useUpdateMutation({
    mutationFn: api.purchase.update.mutationOptions,
    entity: "purchase",
    invalidateKeys: purchaseMutationInvalidateKeys,
  });

  const bulkActions = useMemo(
    () => ({
      actions: [
        {
          id: "move",
          label: "Move to project...",
          icon: <ArrowRightLeft className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: TableRow<PurchaseOut>[]) => {
            setBulkMoveItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
        {
          id: "set-trade",
          label: "Set trade...",
          icon: <Wrench className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: TableRow<PurchaseOut>[]) => {
            setBulkTradeItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
        {
          id: "set-cost-type",
          label: "Set cost type...",
          icon: <Tag className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: TableRow<PurchaseOut>[]) => {
            setBulkCostTypeItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
      ],
      clearSelectionOnComplete: false,
    }),
    [],
  );
  const bulkActionsState = useBulkActions({ config: bulkActions });

  // biome-ignore lint/correctness/useExhaustiveDependencies: updatePurchaseMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      buildSelectColumn<PurchaseOut>(lastSelectedIdRef, shiftKeyRef),
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
              <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
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
              mobile: { slot: "meta", priority: 40, interactive: true },
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
      purchaseCostTypeColumn(
        purchaseHelper,
        async (costType, purchase) => {
          await updatePurchaseMutation.mutateAsync({
            id: purchase.id,
            data: { costType },
          });
        },
        { mobile: { slot: "meta", priority: 20 } },
      ),
      // Negative rows are credits/contributions (money in) — `signedTone`
      // greens them so they don't read as spend; `decimals: 0` keeps the
      // embedded table's whole-dollar density. `exactFilter` keeps the pivot's
      // controlled trade filter to a single trade.
      purchaseTradeColumn(
        purchaseHelper,
        async (trade, purchase) => {
          await updatePurchaseMutation.mutateAsync({
            id: purchase.id,
            data: { trade },
          });
        },
        {
          emptyAsNull: true,
          exactFilter: true,
          mobile: { slot: "meta", priority: 60 },
        },
      ),
      purchaseCostColumn(
        purchaseHelper,
        async (cost, purchase) => {
          await updatePurchaseMutation.mutateAsync({
            id: purchase.id,
            data: { cost },
          });
        },
        {
          className: "w-20",
          decimals: 0,
          signedTone: true,
          mobile: { slot: "trailing", priority: 10, interactive: true },
        },
      ),
      purchaseDateColumn(
        purchaseHelper,
        async (date, purchase) => {
          await updatePurchaseMutation.mutateAsync({
            id: purchase.id,
            data: { date },
          });
        },
        { mobile: { slot: "subtitle", priority: 15 } },
      ),
      purchaseFutureColumn(
        purchaseHelper,
        async (future, purchase) => {
          await updatePurchaseMutation.mutateAsync({
            id: purchase.id,
            data: { future },
          });
        },
        { mobile: { slot: "meta", priority: 50 } },
      ),
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
    enableRowSelection: true,
    state: { rowSelection: bulkActionsState.rowSelection },
    onRowSelectionChange: bulkActionsState.onRowSelectionChange,
    initialState: {
      pagination: { pageSize: 25 },
    },
  });

  // Mirror the pivot's active cell onto the table's column filters. Wrapped in
  // a one-element array because both columns are multi-select: their filterFn
  // expects a set, and a bare scalar would make it match every row.
  useEffect(() => {
    table
      .getColumn("trade")
      ?.setFilterValue(tradeFilter ? [tradeFilter] : undefined);
    table
      .getColumn("costType")
      ?.setFilterValue(costTypeFilter ? [costTypeFilter] : undefined);
  }, [table, tradeFilter, costTypeFilter]);

  const bulkMoveMutation = useActionMutation({
    mutationFn: api.purchase.bulkMove.mutationOptions,
    invalidateKeys: purchaseMutationInvalidateKeys,
    success: (data) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `Moved ${data.items.length} purchase${data.items.length !== 1 ? "s" : ""}`,
      ),
    onSuccess: () => {
      setBulkMoveItems([]);
      table.resetRowSelection();
    },
  });

  const bulkTradeMutation = useActionMutation({
    mutationFn: api.purchase.bulkSetTrade.mutationOptions,
    invalidateKeys: purchaseMutationInvalidateKeys,
    success: (data) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `Updated ${data.items.length} purchase${data.items.length !== 1 ? "s" : ""}`,
      ),
    onSuccess: () => {
      setBulkTradeItems([]);
      table.resetRowSelection();
    },
  });

  const bulkCostTypeMutation = useActionMutation({
    mutationFn: api.purchase.bulkSetCostType.mutationOptions,
    invalidateKeys: purchaseMutationInvalidateKeys,
    success: (data) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `Updated ${data.items.length} purchase${data.items.length !== 1 ? "s" : ""}`,
      ),
    onSuccess: () => {
      setBulkCostTypeItems([]);
      table.resetRowSelection();
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

  const bulkActionBar =
    bulkActionsState.selectedCount > 0 ? (
      <BulkActionBar
        selectedCount={bulkActionsState.selectedCount}
        selectedRows={table.getFilteredSelectedRowModel().rows}
        actions={bulkActionsState.getAvailableActions(
          table.getFilteredSelectedRowModel().rows,
        )}
        onExecute={bulkActionsState.executeAction}
        onClearSelection={bulkActionsState.clearSelection}
        isExecuting={bulkActionsState.isExecuting}
        currentAction={bulkActionsState.currentAction}
      />
    ) : null;

  return (
    <>
      <RTable table={table} embedded bulkActionBar={bulkActionBar} />
      {bulkMoveItems.length > 0 && (
        <MoveToProjectDialog
          open={bulkMoveItems.length > 0}
          onOpenChange={(open) => {
            if (!open) setBulkMoveItems([]);
          }}
          items={bulkMoveItems}
          entityLabel="Purchase"
          isPending={bulkMoveMutation.isPending}
          onConfirm={async (projectId) => {
            await bulkMoveMutation.mutateAsync({
              ids: bulkMoveItems.map((p) => p.id),
              projectId,
            });
          }}
        />
      )}
      {bulkTradeItems.length > 0 && (
        <SetFieldDialog
          open={bulkTradeItems.length > 0}
          onOpenChange={(open) => {
            if (!open) setBulkTradeItems([]);
          }}
          items={bulkTradeItems}
          isPending={bulkTradeMutation.isPending}
          options={tradeOptions}
          fieldLabel="Trade"
          itemNoun="Purchase"
          onConfirm={async (trade) => {
            await bulkTradeMutation.mutateAsync({
              ids: bulkTradeItems.map((p) => p.id),
              trade: trade as Trade,
            });
          }}
        />
      )}
      {bulkCostTypeItems.length > 0 && (
        <SetFieldDialog
          open={bulkCostTypeItems.length > 0}
          onOpenChange={(open) => {
            if (!open) setBulkCostTypeItems([]);
          }}
          items={bulkCostTypeItems}
          isPending={bulkCostTypeMutation.isPending}
          options={costTypeOptions}
          fieldLabel="Cost Type"
          itemNoun="Purchase"
          onConfirm={async (costType) => {
            await bulkCostTypeMutation.mutateAsync({
              ids: bulkCostTypeItems.map((p) => p.id),
              costType: costType as CostType,
            });
          }}
        />
      )}
    </>
  );
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
