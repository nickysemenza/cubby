import type { RowSelectionState } from "@tanstack/react-table";
import { useCallback, useMemo, useState } from "react";

import type { BulkAction } from "~/ui/data-table/bulk-actions.types";
import { BulkActionBar } from "~/ui/data-table/BulkActionBar";
import {
  specFromCellData,
  numberCellData,
  selectCellData,
} from "~/ui/data-table/cell-data";
import { useTableColumnLayout } from "~/ui/data-table/column-layout";
import {
  createCurrencyColumn,
  createImageColumn,
  createNameColumn,
  createPlainDateColumn,
  createTextColumn,
  createTimestampColumn,
  renderOptionCell,
  rowImages,
} from "~/ui/data-table/columnHelpers";
import { EditableCell } from "~/ui/data-table/editable-cell";
import { buildSelectColumn } from "~/ui/data-table/row-selection";
import RTable from "~/ui/data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import type { GroupConfig } from "~/ui/data-table/useGroupedList";
import { Stack } from "~/ui/layout";

import {
  type DemoProduct,
  demoCategoryOptions,
  demoProducts,
} from "../_data/samples";

const GROUP_CONFIG: GroupConfig<DemoProduct> = {
  field: "domain",
  keyFn: (row) => row.domain[0]!.toUpperCase() + row.domain.slice(1),
  colorFn: (label) => `var(--domain-${label.toLowerCase()})`,
};

export function RTableSection() {
  const [rows, setRows] = useState(demoProducts);
  const [grouped, setGrouped] = useState(false);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [executing, setExecuting] = useState<BulkAction<DemoProduct> | null>(
    null,
  );
  // Edits commit to this page's state only; nothing reaches the server.
  const update = useCallback(
    async (id: string, patch: Partial<DemoProduct>) => {
      setRows((current) =>
        current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      );
    },
    [],
  );

  const helper = useMemo(() => createCubbyColumnHelper<DemoProduct>(), []);
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<DemoProduct>((add) => {
        add(buildSelectColumn<DemoProduct>());
        add(
          createImageColumn(helper, {
            entity: "product",
            getImages: rowImages,
          }),
        );
        add(
          createNameColumn(helper, "product", "name", {
            header: "Name",
            rowLink: () => null,
            editable: { onSave: (name, row) => update(row.id, { name }) },
          }),
        );
        add(
          createTextColumn(helper, "location", {
            header: "Location",
            className: "w-40",
            editable: {
              onSave: (location, row) =>
                update(row.id, { location: location ?? "" }),
            },
          }),
        );
        const categoryData = selectCellData<DemoProduct>(
          (row) => row.category,
          demoCategoryOptions,
          (row, category) => update(row.id, { category }),
        );
        add(
          helper.accessor((row) => row.category, {
            id: "category",
            header: "Category",
            meta: attachCubbyColumnMeta<DemoProduct>({
              className: "w-36",
              cellData: categoryData,
            }),
            cell: ({ row, getValue }) => (
              <EditableCell
                value={getValue()}
                onSave={(category) =>
                  update(row.original.id, { category: category ?? "" })
                }
                clipboard={specFromCellData(categoryData, row.original)}
                config={{ type: "select", options: demoCategoryOptions }}
                renderValue={(value) =>
                  renderOptionCell(value, demoCategoryOptions)
                }
              />
            ),
          }),
        );
        const onHandData = numberCellData<DemoProduct>(
          "number",
          (row) => row.onHand,
          (row, onHand) => update(row.id, { onHand: onHand ?? 0 }),
        );
        add(
          helper.accessor((row) => row.onHand, {
            id: "onHand",
            header: "On hand",
            meta: attachCubbyColumnMeta<DemoProduct>({
              className: "w-20",
              numeric: true,
              mono: true,
              cellData: onHandData,
            }),
            cell: ({ row, getValue }) => (
              <EditableCell
                value={getValue()}
                onSave={(onHand) =>
                  update(row.original.id, { onHand: onHand ?? 0 })
                }
                clipboard={specFromCellData(onHandData, row.original)}
                config={{ type: "number", step: "1" }}
                renderValue={(value) => (
                  <span className={value === 0 ? "text-warning" : undefined}>
                    {value ?? "—"}
                  </span>
                )}
              />
            ),
          }),
        );
        add(
          createCurrencyColumn(helper, "price", {
            header: "Price",
            className: "w-24",
            editable: { onSave: (price, row) => update(row.id, { price }) },
          }),
        );
        add(
          createPlainDateColumn(helper, "purchasedOn", {
            header: "Purchased",
            className: "w-28",
            editable: {
              onSave: (purchasedOn, row) => update(row.id, { purchasedOn }),
            },
          }),
        );
        add(createTimestampColumn(helper, "updatedAt"));
      }),
    [helper, update],
  );

  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns,
  });
  const table = useCubbyTable({
    data: rows,
    columns: tableColumns,
    initialState: {
      columnOrder: defaultLayout.columnOrder,
      columnPinning: defaultLayout.columnPinning,
      columnVisibility: defaultLayout.columnVisibility,
    },
    meta: { defaultLayout },
    getRowId: (row) => row.id,
    enableRowSelection: true,
    state: { rowSelection },
    onRowSelectionChange: setRowSelection,
  });

  const selectedRows = table.getSelectedRowModel().rows;
  const actions: BulkAction<DemoProduct>[] = [
    {
      id: "restock",
      label: "Mark restocked",
      onExecute: async (selected) => {
        const ids = new Set(selected.map((row) => row.original.id));
        setRows((current) =>
          current.map((row) =>
            ids.has(row.id) ? { ...row, onHand: row.onHand + 1 } : row,
          ),
        );
        return { success: true };
      },
    },
    {
      id: "retire",
      label: "Retire",
      tone: "destructive",
      availability: (selected) =>
        selected.some((row) => row.original.onHand > 0)
          ? { status: "disabled", reason: "Only products with none on hand" }
          : { status: "available" },
      onExecute: async () => ({ success: true }),
    },
  ];

  return (
    <Stack gap="md">
      <p className="text-xs text-muted-foreground">
        Production lists reach RTable through <code>ListWorkbench</code> and the
        entity manifest; this one is built directly over synthetic rows. Click a
        cell to edit (changes stay on this page), drag across cells to select a
        range and copy or paste it, tick rows for bulk actions, resize or
        reorder columns from the Columns menu, and group by domain.
      </p>
      <RTable
        table={table}
        ariaLabel="Synthetic pantry products"
        embedded
        showColumnMenu
        showCellSelectionStats
        groupConfig={GROUP_CONFIG}
        grouped={grouped}
        onGroupedChange={setGrouped}
        bulkActionBar={
          <BulkActionBar
            selectedCount={selectedRows.length}
            selectedRows={selectedRows}
            actions={actions}
            onExecute={async (action, selected) => {
              setExecuting(action);
              await action.onExecute(selected);
              setExecuting(null);
            }}
            onClearSelection={() => setRowSelection({})}
            isExecuting={executing !== null}
            currentAction={executing}
          />
        }
        emptyState="No synthetic products."
      />
    </Stack>
  );
}
