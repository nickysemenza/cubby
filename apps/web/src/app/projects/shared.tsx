import {
  expenseLineBasisSchema,
  expenseLineKindSchema,
  type ExpenseLineBasis,
  type ExpenseLineKind,
} from "@cubby/schemas/expense-line-kind";
import {
  costTypeSchema,
  type CostType,
  projectKindSchema,
  type ExpenseOut,
  type ProjectFilters,
  type ProjectOut,
  type ProjectStatus,
  projectStatusSchema,
  type TaskOut,
  type TaskStatus,
  taskStatusSchema,
  type Trade,
  tradeSchema,
} from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  ColumnFiltersState,
  ColumnVisibilityState,
} from "@tanstack/react-table";
import { partition } from "es-toolkit";
import { ListFilter, ListTodo, ShoppingCart } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";

import {
  type VendorName,
  WithVendorSearch,
} from "~/app/_components/combobox/with-vendor-search";
import {
  entityCellData,
  numberCellData,
  specFromCellData,
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
  createSubjectProductLinkColumn,
  createTextColumn,
  type FilterConfig,
  type MobileColumnMeta,
  renderOptionCell,
} from "~/app/_components/data-table/columnHelpers";
import { EditableCell } from "~/app/_components/data-table/editable-cell";
import { EditableEntityCell } from "~/app/_components/data-table/editable-entity-cell";
import { InventoryEntriesCell } from "~/app/_components/data-table/inventory-entries-cell";
import {
  ListWorkbench,
  useBoundedListWorkbench,
} from "~/app/_components/data-table/ListWorkbench";
import {
  type CubbyColumnHelper as ColumnHelper,
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyFilterFn as FilterFn,
} from "~/app/_components/data-table/table-features";
import { attachCubbyColumnMeta } from "~/app/_components/data-table/table-meta";
import { ExternalLinkIcon } from "~/app/_components/ExternalLink";
import { useDeferredFilterOptions } from "~/app/_components/hooks/useDeferredFilterOptions";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useEntitySelection } from "~/app/_components/hooks/useEntitySelection";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useOptimisticDelete } from "~/app/_components/hooks/useOptimisticDelete";
import type { ListQueryOptionsFn } from "~/app/_components/hooks/usePaginatedTableCore";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { OrderIdLink } from "~/app/_components/OrderIdLink";
import { TableLink } from "~/app/_components/table/TableLink";
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
import { product } from "~/app/products/product.functions";
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
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityListFor } from "~/entities/entity-list.functions";
import { manifestFilterConfig } from "~/entities/filter-manifest";
import { multiSelectFilterFnBy, type FilterValue } from "~/entities/filters";
import { image } from "~/entities/image.functions";
import type { ProjectRowsRenderer } from "~/lib/list-view-normalization";
import { purchaseLabel } from "~/lib/purchase-label";
import { getStatusBadgeProps } from "~/lib/status-colors";
import { cn, formatCurrency } from "~/lib/utils";
import { persistedVendorId } from "~/lib/vendor-logo";

import { PROJECT_STATUS_OPTIONS, projectKindOptions } from "./project-options";
import { buildProjectTree, type ProjectTreeRow } from "./project-tree";
import { project } from "./project.functions";
import { tradeOptions } from "./trade-options";

/**
 * Stable empty default for `defaultColumnFilters` — an inline `= []` would
 * allocate a fresh array every render and destabilize the `useState`
 * initializer's closure (guard-enforced: `unstable-hook-default`).
 */
const NO_COLUMN_FILTERS: ColumnFiltersState = [];

export { TASK_STATUS_LABELS } from "~/app/tasks/task-options";
export {
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
} from "~/lib/nivo-theme";
export { getCostTypeColor } from "~/lib/status-colors";
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
export { TradeBadge, TradeIcon, tradeOptions } from "./trade-options";

export function StatusIcon({ status }: { status: ProjectStatus | TaskStatus }) {
  const { icon: Icon, className } = getStatusBadgeProps("project", status);
  // Extract just the text color from the bg+text className tuple.
  const textClass =
    className.split(" ").find((c) => c.startsWith("text-")) ??
    "text-muted-foreground";
  return Icon ? <Icon className={cn("size-4 shrink-0", textClass)} /> : null;
}

const taskHelper = createCubbyColumnHelper<TaskOut>();

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
      parseValue: (value) => taskStatusSchema.parse(value),
      onSave: async (newStatus, task) => {
        await save(newStatus, task);
      },
    },
  });
}

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
      parseValue: (value) => tradeSchema.parse(value),
      onSave: async (newTrade, task) => {
        // Required field — a cleared select is a no-op, not a null write.
        if (!newTrade) return;
        await save(newTrade, task);
      },
    },
  });
}

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

const subtaskCountSuffix = (row: TaskOut): ReactNode =>
  row.subtaskCount > 0 ? (
    <Badge variant="outline">
      {row.doneSubtaskCount}/{row.subtaskCount}
    </Badge>
  ) : undefined;

const EMBEDDED_TASK_COLUMNS: ColumnVisibilityState = { createdAt: false };

/** Bounded caller-scoped rows stay client-side; columns and filters remain shared. */
export function TaskList({
  tasks,
  showProjectColumn = true,
  defaultColumnFilters = NO_COLUMN_FILTERS,
}: {
  tasks: TaskOut[];
  showProjectColumn?: boolean;
  defaultColumnFilters?: ColumnFiltersState;
}) {
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(
    () => defaultColumnFilters,
  );

  const updateTaskMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("task", "update"),
    entity: "task",
  });
  const nameEditable = useNameEditable<TaskOut>(updateTaskMutation.mutateAsync);

  // Raw embedded tables intentionally avoid URL-synced list state.
  const deletableConfig = useDeletableConfig({
    mutationFn: entityMutationOptionsFactory("task", "delete"),
    entityLabel: "Task",
    entity: "task",
  });
  const { deleteBulkAction, combinedExtraActions, deleteDialog } =
    useOptimisticDelete<TaskOut>({ deletable: deletableConfig });

  const selection = useEntitySelection<TaskOut>({
    entity: "task",
    deleteBulkAction,
  });

  // One grouped companion read avoids adding stock to every TaskOut producer.
  const subjectProductIds = useMemo(
    () => [
      ...new Set(
        tasks
          .map((task) => task.subjectProductId)
          .filter((id): id is NonNullable<typeof id> => id != null),
      ),
    ],
    [tasks],
  );
  const { data: inventoryByProduct } = useQuery({
    ...product.inventoryEntriesByIds.queryOptions({
      ids: subjectProductIds,
    }),
    enabled: subjectProductIds.length > 0,
  });

  const columns = useMemo(
    () =>
      createCubbyColumnCollection<TaskOut>((add) => {
        selection.selectColumns.forEach(add);
        add(
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
        );
        add(
          createNameColumn(taskHelper, "task", "name", {
            header: "Task",
            editable: nameEditable,
            nameSuffix: subtaskCountSuffix,
          }),
        );
        if (showProjectColumn) {
          add(
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
          );
        }
        add(
          createSubjectProductLinkColumn(taskHelper, {
            className: "w-40",
            mobile: { slot: "meta", priority: 35, interactive: true },
            editable: {
              onSave: async (subjectProductId, task) => {
                await updateTaskMutation.mutateAsync({
                  id: task.id,
                  data: { subjectProductId },
                });
              },
            },
          }),
        );
        add(
          taskHelper.display({
            id: "productLocation",
            header: "Stored at",
            meta: {
              className: "min-w-0 w-40 max-w-56",
              mobile: { slot: "meta", priority: 36, interactive: true },
            },
            cell: ({ row }) => {
              const productId = row.original.subjectProductId;
              return (
                <InventoryEntriesCell
                  entries={
                    (productId ? inventoryByProduct?.[productId] : undefined) ??
                    []
                  }
                  entity="location"
                  getRelatedEntity={(entry) => entry.location}
                  layout="inline"
                  row={row.original}
                />
              );
            },
          }),
        );
        add(
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
        );
        add(
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
        );
        add(createCreatedAtColumn(taskHelper));
        add(
          createActionsColumn(taskHelper, "task", {
            extraActions: combinedExtraActions,
          }),
        );
      }),
    // oxlint-disable-next-line react/exhaustive-deps -- updateTaskMutation changes every render but is functionally stable
    [
      showProjectColumn,
      nameEditable,
      combinedExtraActions,
      inventoryByProduct,
      selection.selectColumns,
    ],
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

  // Embedded and ledger column layouts must not share storage.
  const workbench = useBoundedListWorkbench({
    entity: "task",
    data: sortedData,
    columns,
    layoutKey: "task:embedded",
    layout: {
      initialColumnVisibility: EMBEDDED_TASK_COLUMNS,
      legacyVisibilityKey: "task:embedded",
      legacySizingKey: "task:embedded",
    },
    selection,
    deleteDialog,
    // The table holds its full scoped set, so client-side facet counts are exact.
    getRowId: (row) => row.id,
    enableRowRangeSelection: true,
    state: { columnFilters },
    onColumnFiltersChange: setColumnFilters,
    initialState: { pagination: { pageIndex: 0, pageSize: 25 } },
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

  return <ListWorkbench model={workbench} mode="embedded" showColumnMenu />;
}

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
      parseValue: (value) => expenseLineKindSchema.parse(value),
      onSave: async (newLineKind, expense) => {
        if (!newLineKind) return;
        await save(newLineKind, expense);
      },
    },
  });
}

/** Registered even while hidden so its manifest filter has a real column. */
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
      parseValue: (value) => expenseLineBasisSchema.parse(value),
      onSave: async (newLineBasis, expense) => {
        if (!newLineBasis) return;
        await save(newLineBasis, expense);
      },
    },
  });
}

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
      parseValue: (value) => costTypeSchema.parse(value),
      onSave: async (newCostType, expense) => {
        // Required field — a cleared select is a no-op, not a null write.
        if (!newCostType) return;
        await save(newCostType, expense);
      },
    },
  });
}

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
      parseValue: (value) => tradeSchema.parse(value),
      onSave: async (newTrade, expense) => {
        // Required field — a cleared select is a no-op, not a null write.
        if (!newTrade) return;
        await save(newTrade, expense);
      },
    },
  });
}

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

/** Fractional and signed; the cost-aware schema owns sign/zero validation. */
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
    meta: attachCubbyColumnMeta({
      numeric: true,
      className: "w-24",
      mobile: opts?.mobile,
      filterConfig: opts?.filterConfig,
      cellData,
    }),
    cell: (info) => {
      const row = info.row.original;
      if (!row.productId) return <NoneValue />;
      return (
        <span id={opts?.id?.(row)}>
          <EditableCell
            value={info.getValue()}
            config={{ type: "number", step: "any", placeholder: "Unknown" }}
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
    // `future` is non-null, so false is "Actual", never unknown.
    trueFalseOptions: expenseFutureOptions,
    editable: {
      // `next` is only ever a boolean here: the column declares no `undecided`
      // state, so the editor offers no clear affordance.
      onSave: (next, expense) => save(next ?? false, expense),
    },
  });
}

/** Match id-valued Vendor options against `row.vendorId`, not the displayed name. */
const matchesVendorId = multiSelectFilterFnBy<string | null, FilterValue>(
  (v) => v,
);
const vendorIdFilterFn: FilterFn<ExpenseOut> = (row, columnId, filterValue) =>
  matchesVendorId(
    { getValue: () => row.original.vendorId },
    columnId,
    filterValue,
  );

/**
 * Vendor edits use the full roster to avoid case-variant duplicates; filtering
 * uses id-valued options supplied by each list surface.
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
  const cellData = entityCellData<ExpenseOut, VendorName>(
    "vendor",
    (value) => z.string().min(1).parse(value),
    (row) => (row.vendor ? { id: row.vendor, name: row.vendor } : null),
    (row, value) => save(value, row),
    (row) => save(null, row),
  );

  return helper.accessor((row) => row.vendor, {
    id: "vendor",
    header: opts?.asPurchase ? "Purchase" : "Vendor",
    filterFn: vendorIdFilterFn,
    meta: attachCubbyColumnMeta({
      className: opts?.asPurchase ? "w-56" : "w-40",
      mobile: opts?.mobile,
      filterConfig: manifestFilterConfig(
        "expense",
        "vendor",
        opts?.vendorOptions ? { vendor: opts.vendorOptions } : undefined,
      ),
      cellData,
    }),
    cell: (info) => {
      const expense = info.row.original;
      const vendor = info.getValue();
      return (
        <EditableEntityCell<VendorName>
          value={vendor ? { id: vendor, name: vendor } : null}
          label="vendor"
          clearable
          // Keep editing outside the link trigger.
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
                logo={expense.vendorLogo}
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

/** Presence-filtered order id; its link scopes through the unique Purchase id. */
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

/** Bounded caller-scoped rows stay client-side; columns and filters remain shared. */
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
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(
    () => defaultColumnFilters,
  );

  const updateExpenseMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("expense", "update"),
    entity: "expense",
  });
  const nameEditable = useNameEditable<ExpenseOut>(
    updateExpenseMutation.mutateAsync,
  );

  // Scope id-valued Vendor options and counts to this project's rows.
  const rowVendorOptions = useMemo<FilterableComboboxItem[]>(() => {
    const byId = new Map<
      string,
      { name: string; count: number; logo: ExpenseOut["vendorLogo"] }
    >();
    for (const row of expenses) {
      if (!row.vendorId || !row.vendor) continue;
      const seen = byId.get(row.vendorId);
      if (seen) seen.count += 1;
      else
        byId.set(row.vendorId, {
          name: row.vendor,
          count: 1,
          logo: row.vendorLogo,
        });
    }
    return [...byId]
      .sort(([, a], [, b]) => a.name.localeCompare(b.name))
      .map(([id, { name, count, logo }]) => ({
        value: id,
        label: name,
        hint: String(count),
        icon: <VendorMark vendor={name} vendorId={id} logo={logo} />,
      }));
  }, [expenses]);

  // Raw table state lets the pivot drive filters without URL/page resets.
  const deletableConfig = useDeletableConfig({
    mutationFn: entityMutationOptionsFactory("expense", "delete"),
    entityLabel: "Expense",
    entity: "expense",
  });
  const { deleteBulkAction, combinedExtraActions, deleteDialog } =
    useOptimisticDelete<ExpenseOut>({ deletable: deletableConfig });

  const selection = useEntitySelection<ExpenseOut>({
    entity: "expense",
    deleteBulkAction,
  });

  const columns = useMemo(
    () =>
      createCubbyColumnCollection<ExpenseOut>((add) => {
        selection.selectColumns.forEach(add);
        add(createExpenseProductImageColumn(expenseHelper));
        add(
          createNameColumn(expenseHelper, "expense", "name", {
            header: "Expense",
            editable: nameEditable,
            // The vendor link must not open the cell editor.
            nameSuffix: (expense) =>
              expense.url ? (
                <ExternalLinkIcon href={expense.url} label="Open vendor link" />
              ) : null,
          }),
        );
        // The inline move-to-sub-project affordance — omitted on leaf projects
        // where every row shares the one project (see `showProjectColumn`).
        if (showProjectColumn) {
          add(
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
          );
        }
        add(
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
        );
        // Negative rows are credits/contributions, not spend.
        add(
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
        );
        add(
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
        );
        add(
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
        );
        add(
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
        );
        // Sparse relationship columns remain available through the column menu.
        add(
          createProductLinkColumn(expenseHelper, {
            className: "w-40",
            filterConfig: manifestFilterConfig("expense", "product"),
          }),
        );
        add(
          expenseProductQuantityColumn(
            expenseHelper,
            async (productQuantity, expense) => {
              await updateExpenseMutation.mutateAsync({
                id: expense.id,
                data: { productQuantity },
              });
            },
            {
              filterConfig: manifestFilterConfig("expense", "productQuantity"),
            },
          ),
        );
        add(
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
        );
        add(
          expenseOrderIdColumn(expenseHelper, async (orderId, expense) => {
            await updateExpenseMutation.mutateAsync({
              id: expense.id,
              data: { orderId },
            });
          }),
        );
        add(createCreatedAtColumn(expenseHelper));
        add(
          createActionsColumn(expenseHelper, "expense", {
            extraActions: combinedExtraActions,
          }),
        );
      }),
    // oxlint-disable-next-line react/exhaustive-deps -- updateExpenseMutation changes every render but is functionally stable
    [
      showProjectColumn,
      nameEditable,
      combinedExtraActions,
      rowVendorOptions,
      selection.selectColumns,
    ],
  );

  // Embedded and ledger column layouts must not share storage.
  const workbench = useBoundedListWorkbench({
    entity: "expense",
    data: expenses,
    columns,
    layoutKey: "expense:embedded",
    layout: {
      initialColumnVisibility: EMBEDDED_EXPENSE_COLUMNS,
      legacyVisibilityKey: "expense:embedded",
      legacySizingKey: "expense:embedded",
    },
    selection,
    deleteDialog,
    getRowId: (row) => row.id,
    enableRowRangeSelection: true,
    state: { columnFilters },
    onColumnFiltersChange: setColumnFilters,
    initialState: { pagination: { pageIndex: 0, pageSize: 25 } },
  });

  // Apply pivot transitions as multi-select filters without clearing mount state.
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
    workbench.table
      .getColumn("trade")
      ?.setFilterValue(nextTrade ? [nextTrade] : undefined);
    workbench.table
      .getColumn("costType")
      ?.setFilterValue(nextCostType ? [nextCostType] : undefined);
  }, [workbench.table, tradeFilter, costTypeFilter]);

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

  return (
    <ExpenseProductImages rows={expenses}>
      <ListWorkbench model={workbench} mode="embedded" showColumnMenu />
    </ExpenseProductImages>
  );
}

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
  const isTree = mode === "tree";
  const projectRowsConfig = useMemo(
    () => ({
      nest: (rows: ProjectOut[]): ProjectTreeRow[] =>
        isTree
          ? buildProjectTree(rows)
          : rows.map((project) => ({ ...project, subRows: [] })),
      getSubRows: (row: ProjectTreeRow) => row.subRows,
      expandable: isTree,
    }),
    [isTree],
  );
  // ProjectTreeRow satisfies both invariant ColumnDef modes.
  const columnHelper = useMemo(
    () => createCubbyColumnHelper<ProjectTreeRow>(),
    [],
  );
  const projectOptions = useDeferredFilterOptions("project");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const { data: projectImages } = useQuery({
    ...image.projectSummaries.queryOptions({ projectIds }),
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
  const updateProjectMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("project", "update"),
    entity: "project",
  });

  const nameEditable = useNameEditable<ProjectTreeRow>(
    updateProjectMutation.mutateAsync,
  );

  const deletableConfig = useDeletableConfig({
    mutationFn: entityMutationOptionsFactory("project", "delete"),
    entityLabel: "Project",
    entity: "project",
  });

  const columns = useMemo(
    () =>
      createCubbyColumnCollection<ProjectTreeRow>((add) => {
        add(
          createImageColumn(columnHelper, {
            entity: "project",
            getImages: (project) => projectImages?.[project.id] ?? [],
          }),
        );
        add(
          createFilterableSelectColumn(columnHelper, "status", {
            header: "Status",
            className: "w-32",
            placeholder: "Filter by status...",
            selectOptions: PROJECT_STATUS_OPTIONS,
            mobile: { slot: "subtitle", priority: 10 },
            editable: {
              parseValue: (value) => projectStatusSchema.parse(value),
              onSave: async (newStatus, project) => {
                await updateProjectMutation.mutateAsync({
                  id: project.id,
                  data: { status: newStatus },
                });
              },
            },
          }),
        );
        add(
          createFilterableSelectColumn(columnHelper, "kind", {
            header: "Kind",
            className: "w-32",
            placeholder: "Filter by kind...",
            selectOptions: projectKindOptions,
            mobile: { slot: "meta", priority: 20 },
            editable: {
              parseValue: (value) => projectKindSchema.nullable().parse(value),
              onSave: async (newKind, project) => {
                await updateProjectMutation.mutateAsync({
                  id: project.id,
                  data: { kind: newKind },
                });
              },
            },
          }),
        );
        add(
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
        );
        add(
          columnHelper.accessor("locations", {
            id: "locations",
            header: "Location",
            enableSorting: false,
            meta: {
              className: "w-40",
              mobile: { slot: "meta", priority: 40 },
            },
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
        );
        add(
          createParentLinkColumn(
            columnHelper,
            "project",
            "parentProjectId",
            "parentProjectName",
          ),
        );
        add(
          columnHelper.accessor((row) => row.rollup.subtree.actualSpent, {
            id: "actual",
            header: "Actual",
            // A rollup isn't a stored Project sort field. Keep membership and
            // ordering honest by not pretending this can be sorted in-browser.
            enableSorting: false,
            meta: { numeric: true, className: "w-24" },
            cell: ({ row }) => {
              const { subtree } = row.original.rollup;
              // Actual spend rolls up all live descendants, independent of view filters.
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
        );
        // Show effective dates while editing raw overrides; derived values stay muted.
        add(
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
        );
        add(
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
        );
      }),
    // oxlint-disable-next-line react/exhaustive-deps -- updateProjectMutation changes every render but is functionally stable
    [columnHelper, projectImages],
  );

  const listQueryOptions = useCallback<
    ListQueryOptionsFn<ProjectFilters, ProjectOut>
  >(
    (params) => {
      if (!isTree) return entityListFor("project").listQueryPlan(params);

      const input = project.tree.definition.input.parse(params);
      const policy = project.tree.policy(input);
      return {
        queryKey: project.tree.queryKey(input),
        meta: policy.meta,
        execute: (signal) => project.tree.call(input, { signal }),
      };
    },
    [isTree],
  );

  const tableStateOptions = useMemo(() => ({ initialSort: "startDate" }), []);
  const { workbench, data, totalCount, inspection } = useEntityList<
    ProjectTreeRow,
    ProjectFilters,
    ProjectOut
  >({
    entity: "project",
    preview: { responsiveInspector: true },
    queryOptions: listQueryOptions,
    columns,
    filterOptions,
    deletable: deletableConfig,
    nameEditable,
    namePrefix: projectIconPrefix,
    nameSuffix: subProjectCountSuffix,
    tableStateOptions,
    tree: projectRowsConfig,
  });
  const {
    onRowClick,
    onRowHover,
    onRowHoverEnd,
    PreviewSheet,
    preview,
    dockedInspector,
    inspectorToggle,
  } = inspection;
  const { table } = workbench;

  // Hydrate covers only for loaded rows.
  useEffect(() => {
    const next = data.map((project) => project.id).sort();
    setProjectIds((current) =>
      current.length === next.length &&
      current.every((id, index) => id === next[index])
        ? current
        : next,
    );
  }, [data]);

  // Expand once on search entry so nested matches are visible without fighting users.
  const searching = Boolean(table.getColumn("name")?.getFilterValue());
  useEffect(() => {
    if (!isTree) return;
    table.toggleAllRowsExpanded(searching);
    // oxlint-disable-next-line react/exhaustive-deps -- intentionally edge-triggered on `searching` only
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
      <ListWorkbench
        model={workbench}
        ariaLabel="Projects Table"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        onRowHoverEnd={onRowHoverEnd}
        currentRowId={preview?.rowKey ?? preview?.id}
        desktopInspector={dockedInspector}
        inspectorToggle={inspectorToggle}
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
    </div>
  );
}

/** Tree pagination counts roots, so disclose the distinction and link to flat mode. */
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
