import { capitalize } from "@cubby/shared";
import type { RowSelectionState } from "@tanstack/react-table";
import { useCallback, useMemo, useState } from "react";

import {
  createCurrencyColumn,
  createImageColumn,
  createNameColumn,
  createPlainDateColumn,
  createSelectColumn,
  createTextColumn,
  createTimestampColumn,
  rowImages,
} from "~/entity/table/column-helpers";
import { EditableCell } from "~/entity/table/editable-cell";
import RTable from "~/entity/table/table";
import { BulkActionBar } from "~/ui/data-table/bulk-action-bar";
import type { BulkAction } from "~/ui/data-table/bulk-actions.types";
import { numberCellData, specFromCellData } from "~/ui/data-table/cell-data";
import { useTableColumnLayout } from "~/ui/data-table/column-layout";
import { buildSelectColumn } from "~/ui/data-table/row-selection";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import type { GroupConfig } from "~/ui/data-table/use-grouped-list";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

import {
  type DemoProduct,
  demoCategoryOptions,
  demoProducts,
} from "../data/samples";

const DOMAIN_GROUP_CHOICE: GroupConfig["choice"] = {
  key: "domain",
  label: "Domain",
  noValueLabel: "No domain",
  reason: null,
  value: { kind: "derived", options: null },
  filter: null,
};

/** The server's contract, played locally: contiguous sections with counts. */
function domainSections(rows: readonly DemoProduct[]) {
  const sorted = [...rows].sort((a, b) => a.domain.localeCompare(b.domain));
  const groups: { key: string; label: string; count: number }[] = [];
  for (const row of sorted) {
    const last = groups.at(-1);
    if (last?.key === row.domain) last.count += 1;
    else
      groups.push({ key: row.domain, label: capitalize(row.domain), count: 1 });
  }
  return { sorted, groupConfig: { choice: DOMAIN_GROUP_CHOICE, groups } };
}

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

  const grouping = useMemo(
    () => (grouped ? domainSections(rows) : undefined),
    [grouped, rows],
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
        add(
          createSelectColumn(helper, "category", {
            header: "Category",
            className: "w-36",
            options: demoCategoryOptions,
            editable: {
              onSave: (category, row) =>
                update(row.id, { category: category ?? "" }),
            },
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
    data: grouping?.sorted ?? rows,
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
        groupConfig={grouping?.groupConfig}
        additionalToolbarContent={
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={grouped}
            onClick={() => setGrouped((value) => !value)}
          >
            Group by domain
          </Button>
        }
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
