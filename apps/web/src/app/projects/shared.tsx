import type {
  ExpenseLineBasis,
  ExpenseLineKind,
} from "@cubby/schemas/expense-line-kind";
import type {
  CostType,
  ExpenseOut,
  ProjectOut,
  ProjectStatus,
  TaskOut,
  TaskStatus,
  Trade,
} from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type ColumnFiltersState,
  type ColumnVisibilityState,
  useTable,
} from "@tanstack/react-table";
import { partition } from "es-toolkit";
import { ListFilter, ListTodo, ShoppingCart } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  type VendorName,
  WithVendorSearch,
} from "~/app/_components/combobox/with-vendor-search";
import {
  numberCellData,
  specFromCellData,
  textCellData,
} from "~/app/_components/data-table/cell-data";
import {
  createActionsColumn,
  createBooleanColumn,
  createCreatedAtColumn,
  createCurrencyColumn,
  createFilterableSelectColumn,
  createImageColumn,
  createNameColumn,
  createParentLinkColumn,
  createPlainDateColumn,
  createProductLinkColumn,
  createProjectLinkColumn,
  createTextColumn,
  type FilterConfig,
  type MobileColumnMeta,
  renderOptionCell,
} from "~/app/_components/data-table/columnHelpers";
import { EditableCell } from "~/app/_components/data-table/editable-cell";
import { EditableEntityCell } from "~/app/_components/data-table/editable-entity-cell";
import { buildSelectColumn } from "~/app/_components/data-table/row-selection";
import RTable from "~/app/_components/data-table/Table";
import {
  type CubbyColumnHelper as ColumnHelper,
  type CubbyColumnDef,
  createCubbyColumnHelper,
  cubbyTableFeatures,
  type CubbyFilterFn as FilterFn,
} from "~/app/_components/data-table/table-features";
import { useBulkActions } from "~/app/_components/data-table/useBulkActions";
import { useTableColumnVisibility } from "~/app/_components/data-table/useTableColumnVisibility";
import { ExternalLinkIcon } from "~/app/_components/ExternalLink";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useEntityPreview } from "~/app/_components/hooks/useEntityPreview";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import { ListBulkActionBar } from "~/app/_components/hooks/useListBulkActions";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useOptimisticDelete } from "~/app/_components/hooks/useOptimisticDelete";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { OrderIdLink } from "~/app/_components/OrderIdLink";
import { TableLink } from "~/app/_components/table/TableLink";
import {
  ExpenseBulkActionDialogs,
  useExpenseBulkActions,
} from "~/app/_components/tracker/expense-bulk-actions";
import {
  TaskBulkActionDialogs,
  useTaskBulkActions,
} from "~/app/_components/tracker/task-bulk-actions";
import {
  costTypeOptions,
  expenseFutureOptions,
  expenseLineBasisOptions,
  expenseLineKindOptions,
} from "~/app/expenses/expense-options";
import {
  createExpenseProductImageColumn,
  ExpenseProductImages,
} from "~/app/expenses/expense-product-image-column";
import { ProjectMark } from "~/app/projects/project-mark";
import { taskStatusOptions } from "~/app/tasks/task-options";
import { VendorCell, VendorMark } from "~/components/entity/vendor-cell";
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
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { entities, entityDetailParams } from "~/entities/entities";
import { manifestFilterConfig } from "~/entities/filter-manifest";
import { multiSelectFilterFnBy } from "~/entities/filters";
import { useTRPC } from "~/integrations/trpc/react";
import type { ProjectRowsRenderer } from "~/lib/list-view-normalization";
import { purchaseLabel } from "~/lib/purchase-label";
import {
  expenseMutationInvalidateKeys,
  projectMutationInvalidateKeys,
  taskMutationInvalidateKeys,
} from "~/lib/query-keys";
import { getStatusBadgeProps } from "~/lib/status-colors";
import { cn, formatCurrency } from "~/lib/utils";
import { persistedVendorId } from "~/lib/vendor-logo";
import { PROJECT_STATUS_OPTIONS, projectKindOptions } from "./project-options";
import { buildProjectTree, type ProjectTreeRow } from "./project-tree";
import { tradeOptions } from "./trade-options";

/**
 * Stable empty default for `defaultColumnFilters` — an inline `= []` would
 * allocate a fresh array every render and destabilize the `useState`
 * initializer's closure (guard-enforced: `unstable-hook-default`).
 */
const NO_COLUMN_FILTERS: ColumnFiltersState = [];

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

const taskHelper = createCubbyColumnHelper<TaskOut>();

// These bake the renderCell + select options + editable field-mapping shared by
// the `/tasks` & `/expenses` index pages (tasklist.tsx / expenselist.tsx, via
// `useEntityList`) and the embedded tables below (raw `useTable` over a
// caller-supplied array). Each returns ONE column def; callers pass their own
// `mobile` / `filterConfig` / density knobs. The project column already has its
// own shared factory (`createProjectLinkColumn`); the name column differs per
// caller, so both are left inline.

/** Status column — dot + label render (from the roster) + `status` write. */
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
    mobile: opts?.mobile,
    editable: {
      onSave: async (newStatus, task) => {
        await save(newStatus, task);
      },
    },
  });
}

/** Trade column — the roster's trade glyph + label, and a required `trade`
 * write. `emptyAsNull` renders an
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
    // Only the empty case differs from the shared render: an embedded table
    // suppresses the dash entirely rather than showing "no trade" per row.
    renderCell: (trade: Trade | null) =>
      trade === null && opts?.emptyAsNull
        ? null
        : renderOptionCell(trade, tradeOptions),
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

/** Due-date column — optionally edits the effective end of a due-date range. */
export function taskDueColumn(
  helper: ColumnHelper<TaskOut>,
  save: (
    dueDate: string | null,
    task: TaskOut,
    field: "dueDate" | "dueEndDate",
  ) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta; effective?: boolean },
) {
  return createPlainDateColumn(helper, "dueDate", {
    header: "Due",
    className: "w-28",
    mobile: opts?.mobile,
    editValue: opts?.effective
      ? (task) => task.dueEndDate ?? task.dueDate
      : undefined,
    displayValue: opts?.effective
      ? (task) => ({ value: task.dueEndDate ?? task.dueDate })
      : undefined,
    editable: {
      onSave: async (newDueDate, task) => {
        await save(
          newDueDate,
          task,
          opts?.effective && task.dueEndDate !== null
            ? "dueEndDate"
            : "dueDate",
        );
      },
    },
  });
}

/**
 * `N/M` checklist chip after a parent task's name — the twin of the /tasks
 * ledger's. Module-level so it stays referentially stable across renders (it
 * sits in the columns `useMemo`'s dependency graph).
 */
const subtaskCountSuffix = (row: TaskOut): ReactNode =>
  row.subtaskCount > 0 ? (
    <Badge variant="outline">
      {row.doneSubtaskCount}/{row.subtaskCount}
    </Badge>
  ) : undefined;

/**
 * Columns off by default on the embedded task table. Provenance detail on a
 * project page, reachable from the column menu when you want it.
 */
const EMBEDDED_TASK_COLUMNS: ColumnVisibilityState = { createdAt: false };

/**
 * The embedded task table: client-side filter/sort/pagination over a
 * caller-supplied array, deliberately — NOT an unconverted `useEntityList`.
 *
 * These are bounded sub-lists (one project's tasks, already server-scoped
 * and capped by the caller's query), so server pagination would buy nothing at
 * this data scale. More importantly, this component is also rendered by the
 * projects dashboard's Data view, which scopes rows to
 * `!row.projectId || dashboardProjectIds.has(row.projectId)`, over a project
 * set that only `project.dashboardSummary`'s kind/location chips understand.
 * (`{projectId, projectPresenceFilter: "none"}` now expresses that OR
 * server-side — but the chip-derived project set still doesn't survive the
 * trip.) Converting would mean two data paths in one component, which is how
 * these tables drifted from the index pages before.
 *
 * Columns come from the shared factories above — the same ones the /tasks
 * index page feeds through `useEntityList` — and their filter controls come
 * from the filter manifest via `manifestFilterConfig`, so the embedded and
 * index tables can't diverge even though their data paths differ.
 */
export function TaskList({
  tasks,
  showProjectColumn = true,
  defaultColumnFilters = NO_COLUMN_FILTERS,
}: {
  tasks: TaskOut[];
  /**
   * The Project column is the inline move-to-sub-project affordance — useful
   * when rows span a subtree, but pure noise on a leaf project's detail page
   * where every row is the same project. Callers pass `false` there.
   */
  showProjectColumn?: boolean;
  /** Seeds the table's column filters once on mount; the table owns the state after that. */
  defaultColumnFilters?: ColumnFiltersState;
}) {
  const api = useTRPC();
  const lastSelectedIdRef = useRef<string | null>(null);
  const shiftKeyRef = useRef(false);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(
    () => defaultColumnFilters,
  );

  const updateTaskMutation = useUpdateMutation({
    mutationFn: api.task.update.mutationOptions,
    entity: "task",
    invalidateKeys: taskMutationInvalidateKeys,
  });
  const nameEditable = useNameEditable<TaskOut>(updateTaskMutation.mutateAsync);

  // These tables are raw `useTable`, not `useEntityList`, so delete is
  // hand-wired from the same primitive the list hooks use. (Migrating to
  // `useClientEntityList` would url-sync `sort`/`page`/`size` — and this
  // component renders twice on a project detail page — and would re-sort
  // `sortedData` away.)
  const deletableConfig = useDeletableConfig({
    mutationFn: api.task.delete.mutationOptions,
    entityLabel: "Task",
    invalidateKeys: taskMutationInvalidateKeys,
    entity: "task",
  });
  const { deleteBulkAction, combinedExtraActions, deleteDialog } =
    useOptimisticDelete<TaskOut>({ deletable: deletableConfig });

  const taskDeleteActions = useMemo(
    () => (deleteBulkAction ? [deleteBulkAction] : []),
    [deleteBulkAction],
  );
  const taskBulkActions = useTaskBulkActions({
    extraActions: taskDeleteActions,
  });
  const bulkActionsState = useBulkActions({
    config: taskBulkActions.config,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: updateTaskMutation changes every render but is functionally stable
  const columns = useMemo<CubbyColumnDef<TaskOut>[]>(
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
      createNameColumn(taskHelper, "task", "name", {
        header: "Task",
        editable: nameEditable,
        nameSuffix: subtaskCountSuffix,
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
      createCreatedAtColumn(taskHelper),
      createActionsColumn(taskHelper, "task", {
        extraActions: combinedExtraActions,
      }),
    ],
    [showProjectColumn, nameEditable, combinedExtraActions],
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

  // Own storage scope: this table's column set isn't the /tasks ledger's, so
  // sharing `table-columns:task` would let a toggle here move a column there.
  const { columnVisibility, onColumnVisibilityChange } =
    useTableColumnVisibility("task", EMBEDDED_TASK_COLUMNS, "embedded");

  const table = useTable<typeof cubbyTableFeatures, TaskOut>({
    features: cubbyTableFeatures,
    data: sortedData,
    columns,
    // Feeds the header picklists' `(count)` hints. Client-side faceting is
    // honest here (unlike on a server-paginated ledger): the table holds the
    // whole set it's filtering.
    getRowId: (row) => row.id,
    enableRowSelection: true,
    enableRowRangeSelection: false,
    state: {
      rowSelection: bulkActionsState.rowSelection,
      columnVisibility,
      columnFilters,
    },
    onRowSelectionChange: bulkActionsState.onRowSelectionChange,
    onColumnVisibilityChange,
    onColumnFiltersChange: setColumnFilters,
    initialState: {
      pagination: { pageIndex: 0, pageSize: 25 },
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
      <ListBulkActionBar
        table={table}
        config={taskBulkActions.config}
        state={bulkActionsState}
      />
    ) : null;

  return (
    <>
      <RTable
        table={table}
        // Same scope as this table's column visibility: the embedded task
        // table's column set differs from the main task list's, so their
        // widths must not share a store either.
        sizingKey="task:embedded"
        embedded
        showColumnMenu
        bulkActionBar={bulkActionBar}
      />
      {deleteDialog}
      <TaskBulkActionDialogs
        controller={taskBulkActions}
        onComplete={() => table.resetRowSelection()}
      />
    </>
  );
}

// -- Expense Table --

const expenseHelper = createCubbyColumnHelper<ExpenseOut>();

export function expenseLineKindColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (lineKind: ExpenseLineKind, expense: ExpenseOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta },
) {
  return createFilterableSelectColumn(helper, "lineKind", {
    header: "Line Kind",
    className: "w-36",
    placeholder: "Filter by line kind...",
    selectOptions: expenseLineKindOptions,
    filterConfig: manifestFilterConfig("expense", "lineKind"),
    mobile: opts?.mobile,
    editable: {
      onSave: async (newLineKind, expense) => {
        if (!newLineKind) return;
        await save(newLineKind, expense);
      },
    },
  });
}

/**
 * Itemization column — whether the row is a line item or a slice of an
 * un-itemized total. Hidden by default in `expenselist`: it reads `Line item`
 * on all but a handful of rows, so the filter chip is the surface worth having.
 * Registered anyway because a manifest spec whose `columnId` matches no
 * rendered column renders no control at all, silently.
 */
export function expenseLineBasisColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (lineBasis: ExpenseLineBasis, expense: ExpenseOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta },
) {
  return createFilterableSelectColumn(helper, "lineBasis", {
    header: "Itemization",
    className: "w-40",
    placeholder: "Filter by itemization...",
    selectOptions: expenseLineBasisOptions,
    filterConfig: manifestFilterConfig("expense", "lineBasis"),
    mobile: opts?.mobile,
    editable: {
      onSave: async (newLineBasis, expense) => {
        if (!newLineBasis) return;
        await save(newLineBasis, expense);
      },
    },
  });
}

/** Cost-type column — label render + required `costType` write. */
export function expenseCostTypeColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (costType: CostType, expense: ExpenseOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta },
) {
  return createFilterableSelectColumn(helper, "costType", {
    header: "Cost Type",
    className: "w-28",
    placeholder: "Filter by cost type...",
    selectOptions: costTypeOptions,
    filterConfig: manifestFilterConfig("expense", "costType"),
    mobile: opts?.mobile,
    editable: {
      onSave: async (newCostType, expense) => {
        // Required field — a cleared select is a no-op, not a null write.
        if (!newCostType) return;
        await save(newCostType, expense);
      },
    },
  });
}

/** Trade column — the roster's trade glyph + label, and a required `trade`
 * write. `emptyAsNull` renders
 * an empty cell instead of the muted dash. The multiselect `filterConfig` gives
 * the column `multiSelectFilterFn` (set membership), which the pivot's
 * single-trade selection satisfies as a one-element array. */
export function expenseTradeColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (trade: Trade, expense: ExpenseOut) => Promise<void>,
  opts?: {
    mobile?: MobileColumnMeta;
    emptyAsNull?: boolean;
  },
) {
  return createFilterableSelectColumn(helper, "trade", {
    header: "Trade",
    className: "w-32",
    placeholder: "Filter by trade...",
    selectOptions: tradeOptions,
    filterConfig: manifestFilterConfig("expense", "trade"),
    // Only the empty case differs from the shared render: an embedded table
    // suppresses the dash entirely rather than showing "no trade" per row.
    renderCell: (trade: Trade | null) =>
      trade === null && opts?.emptyAsNull
        ? null
        : renderOptionCell(trade, tradeOptions),
    mobile: opts?.mobile,
    editable: {
      onSave: async (newTrade, expense) => {
        // Required field — a cleared select is a no-op, not a null write.
        if (!newTrade) return;
        await save(newTrade, expense);
      },
    },
  });
}

/** Cost column — `decimals`/`signedTone` tune the embedded whole-dollar,
 * sign-tinted look; the index page omits them for default cents + flat green. */
export function expenseCostColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (cost: number | null, expense: ExpenseOut) => Promise<void>,
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
      onSave: async (newCost, expense) => {
        await save(newCost, expense);
      },
    },
  });
}

/** Whole Product units represented by an Expense. Unknown stays null; a row
 * without a linked Product is deliberately read-only.
 *
 * Signed — this one `saveValid` gates every inline quantity edit in the app
 * (expense list, project detail, purchase table, product expense history), so a
 * `> 0` rule here would make a $0 discard uneditable everywhere, and a `!== 0`
 * rule would do the same to a refund-line price concession. The sign/zero rule
 * is cost-dependent and this editor cannot see cost, so it checks only what is
 * wrong at any cost and lets `assertQuantitySignMatchesCost` reject the rest
 * with a message naming the actual conflict.
 * See `Expense.productQuantity` in schema.ts for the ledger rule. */
export function expenseProductQuantityColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (quantity: number | null, expense: ExpenseOut) => Promise<void>,
  opts?: {
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
    /** Lets a contextual prompt direct focus to one missing quantity. */
    autoOpen?: (expense: ExpenseOut) => boolean;
    /** Stable DOM target for a contextual prompt's scroll-to-editor action. */
    id?: (expense: ExpenseOut) => string;
  },
) {
  const saveValid = async (row: ExpenseOut, quantity: number | null) => {
    if (!row.productId) {
      throw new Error("Link a product before recording its quantity");
    }
    if (quantity !== null && !Number.isInteger(quantity)) {
      throw new Error("Product quantity must be a whole number");
    }
    await save(quantity, row);
  };
  const cellData = numberCellData<ExpenseOut>(
    "number",
    (row) => row.productQuantity,
    saveValid,
  );
  return helper.accessor("productQuantity", {
    id: "productQuantity",
    header: "Quantity",
    enableSorting: true,
    meta: {
      numeric: true,
      className: "w-24",
      mobile: opts?.mobile,
      filterConfig: opts?.filterConfig,
      cellData,
    },
    cell: (info) => {
      const row = info.row.original;
      if (!row.productId) return <NoneValue />;
      return (
        <span id={opts?.id?.(row)}>
          <EditableCell
            value={info.getValue()}
            config={{ type: "number", step: "1", placeholder: "Unknown" }}
            onSave={(quantity) => saveValid(row, quantity)}
            clipboard={specFromCellData(cellData, row)}
            renderValue={(quantity) => quantity ?? <NoneValue />}
            autoOpen={opts?.autoOpen?.(row)}
          />
        </span>
      );
    },
  });
}

/** Date column — inline date-picker + `date` write. */
export function expenseDateColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (date: string | null, expense: ExpenseOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta; filterConfig?: FilterConfig },
) {
  return createPlainDateColumn(helper, "date", {
    header: "Date",
    className: "w-28",
    mobile: opts?.mobile,
    filterConfig: opts?.filterConfig,
    editable: {
      onSave: async (newDate, expense) => {
        await save(newDate, expense);
      },
    },
  });
}

/** Future/Status column — the editable "Actual"/"Planned" select over the
 * boolean `future` field. */
export function expenseFutureColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (future: boolean, expense: ExpenseOut) => Promise<void>,
  opts?: {
    className?: string;
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
  },
) {
  return createBooleanColumn(helper, "future", {
    header: "Status",
    className: opts?.className ?? "w-24",
    mobile: opts?.mobile,
    filterConfig: opts?.filterConfig ?? null,
    // "Actual" rather than a dash: `future` is `NOT NULL DEFAULT false`, so a
    // made expense is a recorded fact, not a missing one. This cell used to
    // render `<NoneValue />` for false, which is how the great majority of the
    // ledger came to display the unknown-marker for a value that was never in
    // doubt.
    trueFalseOptions: expenseFutureOptions,
    editable: {
      // `next` is only ever a boolean here: the column declares no `undecided`
      // state, so the editor offers no clear affordance.
      onSave: (next, expense) => save(next ?? false, expense),
    },
  });
}

/**
 * Client-side matching for the Vendor picklist, on the vendor ID.
 *
 * The cell shows the vendor's NAME, but the roster's option values are vendor
 * ids (that's what the manifest's `vendorId` filter matches server-side), so the
 * default `multiSelectFilterFn` — which reads the column's own cell value —
 * would compare an id against a name and quietly match nothing. This reads
 * `vendorId` off the row instead; sentinel handling (`(none)` / `Has vendor`)
 * stays in `multiSelectFilterFnBy`, so the client table's OR semantics still
 * mirror `eqAnyOrPresence`. Server-filtered tables (the /expenses ledger) never
 * run it.
 */
const matchesVendorId = multiSelectFilterFnBy((v) => v as string | null);
const vendorIdFilterFn: FilterFn<ExpenseOut> = (row, columnId, filterValue) =>
  matchesVendorId(
    { getValue: () => row.original.vendorId },
    columnId,
    filterValue,
  );

/**
 * Vendor column — the charge's vendor, displayed by name and written by name
 * (`expenseUpdateData.vendor` still resolves a name to a real `Vendor` +
 * `Purchase` server-side). Hidden by default wherever it appears (see
 * `initialColumnVisibility` in expenselist.tsx, and the embedded table's own
 * visibility default) because a charge is attached to only ~30% of rows.
 *
 * Leads with the vendor's brand mark (`VendorCell`) so long runs of the same
 * vendor — 539 of the 737 vendor-bearing rows are Amazon/Home Depot/eBay/Lowe's
 * — are scannable by shape rather than by reading. `w-40` rather than `w-32`:
 * the mark costs ~24px and the narrower column already truncated "Direct Tools
 * Outlet".
 *
 * **The editor is a roster picker, not a text box.** `findOrCreateVendor` matches
 * names exactly (trimmed, case-sensitive, deliberately), so a free-text cell made
 * inline-typing `amazon` next to an existing `Amazon` silently mint a second
 * roster row — with no detector to catch it. `WithVendorSearch` offers the whole
 * `vendor.options` roster and saves the picked option's name **verbatim**, so a
 * pick can only ever resolve to the vendor that produced it. Typing a genuinely
 * new vendor still works (a first purchase at a new store shouldn't require a
 * detour to /vendors) but is no longer the accidental default: the combobox only
 * offers "Create new vendor: …" once the typed term matches nothing on the
 * roster, exactly like the product/location pickers.
 *
 * Hand-rolled rather than `createTextColumn(…, { editable })` for that reason —
 * the shared text factory's editor is an `<Input>`. Everything else is kept
 * byte-equivalent to it (same id, `w-40`, `textCellData` clipboard kind, so a
 * copied vendor name still pastes across text cells and into the ledger from a
 * spreadsheet).
 *
 * Its FILTER is a separate, id-based picklist, so a caller must supply the roster
 * of `{value: vendorId, label: name}` options. The ledger routes the global
 * `expense.vendorOptions` query in through `useEntityList`'s `filterOptions`
 * (which overrides this config wholesale); the embedded table passes
 * `vendorOptions` here, derived from the rows it was handed. The EDITOR
 * deliberately does not reuse those: a row-derived list can't offer a vendor
 * that isn't already on screen, so `WithVendorSearch` queries the full roster
 * itself and both call sites get it without threading anything.
 */
export function expenseVendorColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (vendor: string | null, expense: ExpenseOut) => Promise<void>,
  opts?: {
    mobile?: MobileColumnMeta;
    vendorOptions?: FilterableComboboxItem[];
    /** Render the charge identity/link while retaining vendor editing/filtering. */
    asPurchase?: boolean;
  },
) {
  const cellData = {
    ...textCellData<ExpenseOut>(
      "text",
      (row) => row.vendor,
      (row, value) => save(value, row),
    ),
    applyClear: async (row: ExpenseOut) => {
      await save(null, row);
      return null;
    },
  };

  return helper.accessor((row) => row.vendor, {
    id: "vendor",
    header: opts?.asPurchase ? "Purchase" : "Vendor",
    // Overrides the name-based `multiSelectFilterFn` a multiselect text column
    // would otherwise get — see `vendorIdFilterFn` for why the two can't be the
    // same function here.
    filterFn: vendorIdFilterFn,
    meta: {
      className: opts?.asPurchase ? "w-56" : "w-40",
      mobile: opts?.mobile,
      filterConfig: manifestFilterConfig(
        "expense",
        "vendor",
        opts?.vendorOptions ? { vendor: opts.vendorOptions } : undefined,
      ),
      cellData,
    },
    cell: (info) => {
      const expense = info.row.original;
      const vendor = info.getValue();
      return (
        <EditableEntityCell<VendorName>
          // id === name: the server contract is name-based, so the picker's
          // identity is the name. See `WithVendorSearch`'s doc.
          value={vendor ? { id: vendor, name: vendor } : null}
          label="vendor"
          // A charge's vendor is optional — toggling the selected row off clears
          // it, same as emptying the old text input did.
          clearable
          // The value is a real vendor link whenever the persisted shortcode is
          // available. Keep editing on its own control so the link is never
          // nested inside the default button trigger.
          trigger="pencil"
          onSave={(newVendor) => save(newVendor, expense)}
          clipboard={specFromCellData(cellData, expense)}
          SearchProvider={WithVendorSearch}
          renderValue={(v) => {
            if (opts?.asPurchase) {
              if (expense.purchaseId) {
                const label = purchaseLabel({
                  orderId: expense.orderId,
                  displayLabel: expense.purchaseDisplayLabel,
                  vendorName: v?.name ?? expense.vendor,
                  date: expense.purchaseDate,
                });
                return (
                  <TableLink
                    to={entities.purchase.routes.detail}
                    params={entityDetailParams(expense.purchaseId)}
                    className="block truncate"
                  >
                    <span title={label}>{label}</span>
                  </TableLink>
                );
              }
              return v ? (
                <span className="truncate">{v.name}</span>
              ) : (
                <span className="text-muted-foreground">(none)</span>
              );
            }
            return v ? (
              <VendorCell
                vendor={v.name}
                vendorId={persistedVendorId(v.name, expense)}
                compactOnMobile
              />
            ) : (
              <NoneValue />
            );
          }}
        />
      );
    },
  });
}

/**
 * Order # column — the charge's own order/receipt id, written through the
 * expense (`expenseUpdateData.orderId`). Rendered `font-mono` (house convention
 * for identifiers). Hidden by default on the /expenses ledger; see
 * `expenseVendorColumn`. Its filter is presence-only ("has order id" /
 * "(none)") — the "(none)" side is the unreconciled worklist.
 *
 * The trailing icon scopes the ledger to the rest of that order, by id alone: it
 * resolves through `purchaseId` against a partial-unique `(vendorId, orderId)`,
 * so it no longer has to carry the row's vendor to stay unambiguous. Rich
 * display mode keeps that link beside a dedicated pencil trigger, so navigation
 * never also opens the inline editor.
 */
export function expenseOrderIdColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (orderId: string | null, expense: ExpenseOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta },
) {
  return createTextColumn(helper, "orderId", {
    header: "Order #",
    placeholder: "Vendor order #",
    className: "w-32",
    mobile: opts?.mobile,
    filterConfig: manifestFilterConfig("expense", "orderId"),
    trigger: "pencil",
    renderValue: (v, expense) =>
      v ? (
        <>
          <span className="font-mono">{v}</span>
          <Link
            to="/expenses"
            search={{ order: v }}
            className="text-muted-foreground hover:text-foreground"
            aria-label={`Show the rest of order ${v}`}
          >
            <ListFilter className="size-3.5" />
          </Link>
          <OrderIdLink
            orderUrl={expense.orderUrl}
            orderId={v}
            vendorName={expense.vendor}
          />
        </>
      ) : (
        <NoneValue />
      ),
    editable: {
      onSave: async (newOrderId, expense) => {
        await save(newOrderId, expense);
      },
    },
  });
}

/**
 * Columns off by default on the embedded expense table. Vendor (~30% filled),
 * Order # (~25%) and Product are sparse enough that showing them by default
 * would cost more density than they return on a project page — but the column
 * menu makes them one click away.
 */
const EMBEDDED_EXPENSE_COLUMNS: ColumnVisibilityState = {
  vendor: false,
  orderId: false,
  product: false,
  productQuantity: false,
  createdAt: false,
};

/**
 * The embedded expense table: client-side filter/sort/pagination over a
 * caller-supplied array, deliberately — NOT an unconverted `useEntityList`.
 *
 * These are bounded sub-lists (one project's expenses, already server-scoped
 * and capped by the caller's query), so server pagination would buy nothing at
 * this data scale. More importantly, this component is also rendered by the
 * projects dashboard's Data view, which scopes rows to
 * `!row.projectId || dashboardProjectIds.has(row.projectId)`, over a project
 * set that only `project.dashboardSummary`'s kind/location chips understand.
 * (`{projectId, projectPresenceFilter: "none"}` now expresses that OR
 * server-side — but the chip-derived project set still doesn't survive the
 * trip.) Converting would mean two data paths in one component, which is how
 * these tables drifted from the index pages before.
 *
 * Columns come from the shared factories above — the same ones the /expenses
 * index page feeds through `useEntityList` — and their filter controls come
 * from the filter manifest via `manifestFilterConfig`, so the embedded and
 * index tables can't diverge even though their data paths differ.
 */
export function ExpenseList({
  expenses,
  tradeFilter,
  costTypeFilter,
  showProjectColumn = true,
  defaultColumnFilters = NO_COLUMN_FILTERS,
}: {
  expenses: ExpenseOut[];
  /** Controlled column filters, driven by the Trade × Cost Type pivot click. */
  tradeFilter?: Trade | null;
  costTypeFilter?: CostType | null;
  /**
   * The Project column is the inline move-to-sub-project affordance — noise on
   * a leaf project's detail page where every row is the same project. Callers
   * pass `false` there.
   */
  showProjectColumn?: boolean;
  /** Seeds the table's column filters once on mount; the table owns the state after that. */
  defaultColumnFilters?: ColumnFiltersState;
}) {
  const api = useTRPC();
  const lastSelectedIdRef = useRef<string | null>(null);
  const shiftKeyRef = useRef(false);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(
    () => defaultColumnFilters,
  );

  const updateExpenseMutation = useUpdateMutation({
    mutationFn: api.expense.update.mutationOptions,
    entity: "expense",
    invalidateKeys: expenseMutationInvalidateKeys,
  });
  const nameEditable = useNameEditable<ExpenseOut>(
    updateExpenseMutation.mutateAsync,
  );

  // The Vendor picklist's roster, from the rows this table was handed rather
  // than the ledger-wide `expense.vendorOptions` query: on a project page the
  // useful question is "which vendors did THIS project use", and offering the
  // other 70 would mostly be options that match nothing.
  //
  // Same option SHAPE as the ledger's (`value` = vendor id, `label` = name), so
  // both surfaces filter on the identity the server does — see
  // `vendorIdFilterFn`. Counts are tallied off these rows rather than from
  // TanStack faceting: faceting keys on the column's cell value, which is the
  // NAME, so it can't hint an id-valued option.
  const rowVendorOptions = useMemo<FilterableComboboxItem[]>(() => {
    const byId = new Map<string, { name: string; count: number }>();
    for (const row of expenses) {
      if (!row.vendorId || !row.vendor) continue;
      const seen = byId.get(row.vendorId);
      if (seen) seen.count += 1;
      else byId.set(row.vendorId, { name: row.vendor, count: 1 });
    }
    return [...byId]
      .sort(([, a], [, b]) => a.name.localeCompare(b.name))
      .map(([id, { name, count }]) => ({
        value: id,
        label: name,
        hint: String(count),
        icon: <VendorMark vendor={name} vendorId={id} />,
      }));
  }, [expenses]);

  // Hand-wired for the same reason as `TaskList` above — raw `useTable`,
  // and the pivot drives `trade`'s column filter imperatively, which
  // `useClientEntityList` would funnel into url state and a page reset.
  const deletableConfig = useDeletableConfig({
    mutationFn: api.expense.delete.mutationOptions,
    entityLabel: "Expense",
    invalidateKeys: expenseMutationInvalidateKeys,
    entity: "expense",
  });
  const { deleteBulkAction, combinedExtraActions, deleteDialog } =
    useOptimisticDelete<ExpenseOut>({ deletable: deletableConfig });

  const expenseDeleteActions = useMemo(
    () => (deleteBulkAction ? [deleteBulkAction] : []),
    [deleteBulkAction],
  );
  const expenseBulkActions = useExpenseBulkActions({
    extraActions: expenseDeleteActions,
  });
  const bulkActionsState = useBulkActions({
    config: expenseBulkActions.config,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: updateExpenseMutation changes every render but is functionally stable
  const columns = useMemo<CubbyColumnDef<ExpenseOut>[]>(
    () => [
      buildSelectColumn<ExpenseOut>(lastSelectedIdRef, shiftKeyRef),
      createExpenseProductImageColumn(expenseHelper),
      createNameColumn(expenseHelper, "expense", "name", {
        header: "Expense",
        editable: nameEditable,
        // The name itself goes to /expenses/$id; the vendor page keeps its own
        // icon-only affordance beside it (same treatment as the index list's
        // dedicated url column, minus the column). stopPropagation so it opens
        // the vendor link instead of the cell's inline editor.
        nameSuffix: (expense) =>
          expense.url ? (
            <ExternalLinkIcon href={expense.url} label="Open vendor link" />
          ) : null,
      }),
      // The inline move-to-sub-project affordance — omitted on leaf projects
      // where every row shares the one project (see `showProjectColumn`).
      ...(showProjectColumn
        ? [
            createProjectLinkColumn(expenseHelper, {
              className: "w-40",
              mobile: { slot: "meta", priority: 40, interactive: true },
              editable: {
                onSave: async (newProjectId, expense) => {
                  await updateExpenseMutation.mutateAsync({
                    id: expense.id,
                    data: { projectId: newProjectId },
                  });
                },
              },
            }),
          ]
        : []),
      expenseCostTypeColumn(
        expenseHelper,
        async (costType, expense) => {
          await updateExpenseMutation.mutateAsync({
            id: expense.id,
            data: { costType },
          });
        },
        { mobile: { slot: "meta", priority: 20 } },
      ),
      // Negative rows are credits/contributions (money in) — `signedTone`
      // greens them so they don't read as spend; `decimals: 0` keeps the
      // embedded table's whole-dollar density.
      expenseTradeColumn(
        expenseHelper,
        async (trade, expense) => {
          await updateExpenseMutation.mutateAsync({
            id: expense.id,
            data: { trade },
          });
        },
        {
          emptyAsNull: true,
          mobile: { slot: "meta", priority: 60 },
        },
      ),
      expenseCostColumn(
        expenseHelper,
        async (cost, expense) => {
          await updateExpenseMutation.mutateAsync({
            id: expense.id,
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
      expenseDateColumn(
        expenseHelper,
        async (date, expense) => {
          if (date === null) return;
          await updateExpenseMutation.mutateAsync({
            id: expense.id,
            data: { date },
          });
        },
        { mobile: { slot: "subtitle", priority: 15 } },
      ),
      expenseFutureColumn(
        expenseHelper,
        async (future, expense) => {
          await updateExpenseMutation.mutateAsync({
            id: expense.id,
            data: { future },
          });
        },
        { mobile: { slot: "meta", priority: 50 } },
      ),
      // Vendor / Order # / Product are sparse (~30% / ~25% / rarer still), so
      // they stay off by default — but they're reachable now, via the column
      // menu `showColumnMenu` keeps on screen. (They used to be omitted
      // outright: without that menu any column added here was permanent.)
      createProductLinkColumn(expenseHelper, {
        className: "w-40",
        filterConfig: manifestFilterConfig("expense", "product"),
      }),
      expenseProductQuantityColumn(
        expenseHelper,
        async (productQuantity, expense) => {
          await updateExpenseMutation.mutateAsync({
            id: expense.id,
            data: { productQuantity },
          });
        },
        { filterConfig: manifestFilterConfig("expense", "productQuantity") },
      ),
      expenseVendorColumn(
        expenseHelper,
        async (vendor, expense) => {
          await updateExpenseMutation.mutateAsync({
            id: expense.id,
            data: { vendor },
          });
        },
        // Roster (and counts) from the rows on screen, so the picklist describes
        // THIS project's spend rather than the whole ledger.
        { vendorOptions: rowVendorOptions },
      ),
      expenseOrderIdColumn(expenseHelper, async (orderId, expense) => {
        await updateExpenseMutation.mutateAsync({
          id: expense.id,
          data: { orderId },
        });
      }),
      createCreatedAtColumn(expenseHelper),
      createActionsColumn(expenseHelper, "expense", {
        extraActions: combinedExtraActions,
      }),
    ],
    [showProjectColumn, nameEditable, combinedExtraActions, rowVendorOptions],
  );

  // Own storage scope — this column set isn't the /expenses ledger's, so a
  // toggle here must not move a column there.
  const { columnVisibility, onColumnVisibilityChange } =
    useTableColumnVisibility("expense", EMBEDDED_EXPENSE_COLUMNS, "embedded");

  const table = useTable<typeof cubbyTableFeatures, ExpenseOut>({
    features: cubbyTableFeatures,
    data: expenses,
    columns,
    // Vendor counts still come from `rowVendorOptions`: table faceting keys on
    // the cell value (the vendor NAME), so it cannot hint an option whose value
    // is a vendor id.
    getRowId: (row) => row.id,
    enableRowSelection: true,
    enableRowRangeSelection: false,
    state: {
      rowSelection: bulkActionsState.rowSelection,
      columnVisibility,
      columnFilters,
    },
    onRowSelectionChange: bulkActionsState.onRowSelectionChange,
    onColumnVisibilityChange,
    onColumnFiltersChange: setColumnFilters,
    initialState: {
      pagination: { pageIndex: 0, pageSize: 25 },
    },
  });

  // Mirror the pivot's active cell (Trade × Cost Type matrix click) onto the
  // table's column filters. Guarded by a ref so it fires only on a real pivot
  // transition — an unguarded effect writes `undefined` into both columns on
  // mount, wiping any seeded default or user-set filter. Wrapped in a
  // one-element array because both columns are multi-select (their filterFn
  // expects a set; a bare scalar would match every row).
  const lastPivotRef = useRef<{
    trade: Trade | null;
    costType: CostType | null;
  }>({ trade: null, costType: null });
  useEffect(() => {
    const prev = lastPivotRef.current;
    const nextTrade = tradeFilter ?? null;
    const nextCostType = costTypeFilter ?? null;
    if (prev.trade === nextTrade && prev.costType === nextCostType) return;
    lastPivotRef.current = { trade: nextTrade, costType: nextCostType };
    table
      .getColumn("trade")
      ?.setFilterValue(nextTrade ? [nextTrade] : undefined);
    table
      .getColumn("costType")
      ?.setFilterValue(nextCostType ? [nextCostType] : undefined);
  }, [table, tradeFilter, costTypeFilter]);

  if (expenses.length === 0) {
    return (
      <Empty variant="minimal" className="py-6">
        <EmptyHeader>
          <EmptyIcon icon={ShoppingCart} />
          <EmptyTitle>No expenses found</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  const bulkActionBar =
    bulkActionsState.selectedCount > 0 ? (
      <ListBulkActionBar
        table={table}
        config={expenseBulkActions.config}
        state={bulkActionsState}
      />
    ) : null;

  return (
    <ExpenseProductImages rows={expenses}>
      <RTable
        table={table}
        sizingKey="expense:embedded"
        embedded
        showColumnMenu
        bulkActionBar={bulkActionBar}
      />
      {deleteDialog}
      <ExpenseBulkActionDialogs
        controller={expenseBulkActions}
        onComplete={() => table.resetRowSelection()}
      />
    </ExpenseProductImages>
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

const projectIconPrefix = (row: ProjectOut): ReactNode => (
  <ProjectMark icon={row.icon} />
);

/**
 * The Projects Data-tab list, in one of two renderers.
 *
 * `flat` — fully server-filtered rows; hierarchy is an ordinary Parent column.
 * `tree` — the same rows drawn as an expandable WBS. Only the *renderer*
 * differs: `project.tree` applies identical filters and sorting, and merely
 * pages by root of the filtered forest instead of by row, so `buildProjectTree`
 * nests rows the server already chose and ordered. Nothing about membership
 * moves into the browser.
 */
const PROJECT_TREE_CONFIG = {
  nest: buildProjectTree,
  getSubRows: (row: ProjectTreeRow) => row.subRows,
  expandable: true,
};

const PROJECT_ROWS_RENDERER_OPTIONS: ViewSwitcherOption<ProjectRowsRenderer>[] =
  [
    { value: "flat", label: "Flat" },
    { value: "tree", label: "Tree" },
  ];

export function ProjectTable({
  locations,
  completionYears,
  mode,
  onModeChange,
}: {
  locations: string[];
  completionYears: string[];
  mode: ProjectRowsRenderer;
  onModeChange: (mode: ProjectRowsRenderer) => void;
}) {
  const api = useTRPC();
  const isTree = mode === "tree";
  // Helper'd over `ProjectTreeRow` in both modes: TanStack's `ColumnDef` is
  // invariant in `TData`, so a `ProjectOut` helper wouldn't typecheck against
  // the tree table. `ProjectTreeRow` is a structural supertype of `ProjectOut`
  // and every accessor below reads only `ProjectOut` fields, so this is a pure
  // type-parameter swap with no behavioural difference in flat mode.
  const columnHelper = useMemo(
    () => createCubbyColumnHelper<ProjectTreeRow>(),
    [],
  );
  const { options: projectOptions } = useProjectOptions();
  const projectIds = useMemo(
    () => projectOptions.map((project) => project.value),
    [projectOptions],
  );
  const { data: projectImages } = useQuery({
    ...api.image.imagesByProjectIds.queryOptions({ projectIds }),
    staleTime: 5 * 60 * 1000,
    enabled: projectIds.length > 0,
  });
  const filterOptions = useFilterOptions({
    project: projectOptions,
    projectLocations: locations.map((value) => ({ value, label: value })),
    projectCompletionYears: completionYears.map((value) => ({
      value,
      label: value,
    })),
  });
  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview("project");

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
    entity: "project",
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: updateProjectMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      createImageColumn(columnHelper, {
        entity: "project",
        getImages: (project) => projectImages?.[project.id] ?? [],
      }),
      createFilterableSelectColumn(columnHelper, "status", {
        header: "Status",
        className: "w-32",
        placeholder: "Filter by status...",
        selectOptions: PROJECT_STATUS_OPTIONS,
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
      createParentLinkColumn(
        columnHelper,
        "project",
        "parentProjectId",
        "parentProjectName",
      ),
      columnHelper.accessor((row) => row.rollup.subtree.actualSpent, {
        id: "actual",
        header: "Actual",
        // A rollup isn't a stored Project sort field. Keep membership and
        // ordering honest by not pretending this can be sorted in-browser.
        enableSorting: false,
        meta: { numeric: true, className: "w-24" },
        cell: ({ row }) => {
          const { subtree } = row.original.rollup;
          // `actualSpent` = money already out (excludes planned/future +
          // negative contributions), matching the detail hero's "Actual" so
          // this column never means something the hero doesn't. subtree
          // aggregates are over LIVE descendants — not the currently
          // chip-filtered `projects` view (same caveat as
          // spending-by-project.tsx): a filtered-out child's spend still
          // rolls up into its visible parent's "Actual" here.
          //
          // Read unconditionally: a leaf's subtree IS its own rollup and its
          // subtree estimate IS its own estimate (repo/project/subtree.ts,
          // pinned by the "no-branch invariant" integration test), so there
          // is no projectCount branch or `?? costEstimate` fallback to make.
          const actual = subtree.actualSpent;
          if (actual === 0) return <NoneValue />;
          const est = subtree.costEstimate;
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
      // Display the EFFECTIVE window (rolled up from tasks/expenses/live
      // sub-projects, or the override when set); the inline editor still
      // opens on and saves to the raw startDate/endDate override columns —
      // see `displayValue`'s doc comment on `createPlainDateColumn`. A
      // "derived" value renders muted so a computed date reads as distinct
      // from a typed-in one.
      createPlainDateColumn(columnHelper, "startDate", {
        header: "Start",
        className: "w-28",
        mobile: { slot: "meta", priority: 50 },
        displayValue: (project) => ({
          value: project.dates.effectiveStart,
          muted: project.dates.startSource === "derived",
        }),
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
        displayValue: (project) => ({
          value: project.dates.effectiveEnd,
          muted: project.dates.endSource === "derived",
        }),
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
    [columnHelper, projectImages],
  );

  const tableStateOptions = useMemo(() => ({ initialSort: "startDate" }), []);
  const {
    table,
    data,
    totalCount,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
    isLoading,
    error,
    timing,
  } = useEntityList({
    entity: "project",
    queryOptions: isTree
      ? api.project.tree.queryOptions
      : api.project.list.queryOptions,
    columns,
    filterOptions,
    deletable: deletableConfig,
    nameEditable,
    namePrefix: projectIconPrefix,
    nameSuffix: subProjectCountSuffix,
    tableStateOptions,
    tree: isTree ? PROJECT_TREE_CONFIG : undefined,
  });

  // Auto-expand the whole tree while a name search is active, so a match
  // nested under an ALSO-matching ancestor is actually visible; collapse back
  // once the search is cleared. (A match with no matching ancestor is already
  // a root of its own — the server promotes it — so this only covers the
  // parent-matches-too case.) Edge-triggered on `searching` alone (not every
  // keystroke, and not on `table`, which is otherwise a stable ref) so it
  // doesn't fight a user who manually expanded/collapsed rows mid-search.
  const searching = Boolean(table.getColumn("name")?.getFilterValue());
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally edge-triggered on `searching` only
  useEffect(() => {
    if (!isTree) return;
    table.toggleAllRowsExpanded(searching);
  }, [searching, isTree]);

  return (
    <div>
      <Row justify="end" className="pb-2">
        <ViewSwitcher
          ariaLabel="Projects row renderer"
          options={PROJECT_ROWS_RENDERER_OPTIONS}
          value={mode}
          onValueChange={onModeChange}
        />
      </Row>
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
      {isTree && (
        <TreePaginationNote
          // Core rows are the TOP-LEVEL rows (each carrying its `subRows`);
          // `getRowModel()` would count expanded descendants too.
          loadedRoots={table.getCoreRowModel().rows.length}
          totalRoots={totalCount}
          loadedRows={data.length}
          onShowFlat={() => onModeChange("flat")}
        />
      )}
      <PreviewSheet />
      {deleteDialog}
    </div>
  );
}

/**
 * Honesty footnote for the WBS renderer: it pages by top-level project, so the
 * record count means something different here than in the flat list. Same
 * dotted-underline "here's what you're not seeing" idiom as
 * `HiddenByDateNote` in projects-dashboard.tsx, with an escape hatch to the
 * complete flat List rather than a way to widen this one.
 */
function TreePaginationNote({
  loadedRoots,
  totalRoots,
  loadedRows,
  onShowFlat,
}: {
  loadedRoots: number;
  /** `undefined` until the first response lands. */
  totalRoots: number | undefined;
  loadedRows: number;
  onShowFlat: () => void;
}) {
  if (totalRoots === undefined) return null;
  const nested = loadedRows - loadedRoots;

  return (
    <Row gap="xs" wrap className="px-1 pt-1 text-2xs text-muted-foreground">
      <span>
        Paginated by top-level project: {loadedRoots} of {totalRoots} loaded
        {nested > 0
          ? `, plus ${nested} matching sub-project${nested === 1 ? "" : "s"}`
          : ""}
        .
      </span>
      <button
        type="button"
        onClick={onShowFlat}
        className="underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        Show every match as a flat list
      </button>
    </Row>
  );
}
