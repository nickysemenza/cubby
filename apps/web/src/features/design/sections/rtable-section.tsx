import { capitalize } from "@cubby/shared";
import type { RowSelectionState } from "@tanstack/react-table";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

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
import { formatCurrency } from "~/lib/number-format";
import { Picker } from "~/ui/combobox/picker";
import type { BulkAction } from "~/ui/data-table/bulk-actions.types";
import { BulkActionBar } from "~/ui/data-table/bulk/bulk-action-bar";
import { numberCellData, specFromCellData } from "~/ui/data-table/cell-data";
import { CellBar, CellSparkline } from "~/ui/data-table/cell-visual";
import { useTableColumnLayout } from "~/ui/data-table/column-layout";
import { buildSelectColumn } from "~/ui/data-table/row-selection";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import type { GroupConfig } from "~/ui/data-table/use-grouped-list";
import { Row, Stack } from "~/ui/layout";
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
  levels: 0,
  levelReason:
    "Domain is a value, not a record with parents, so it has no levels.",
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

// Memoized table rows retain their cell closures; context updates presentation
// without replacing columns or discarding row selection and edits.
const CellPresentation = createContext(true);

const PRESENTATIONS = [
  { value: "visual", label: "Visual cells" },
  { value: "plain", label: "Plain values" },
];

// Fixed synthetic evidence, independent of ordering, grouping, and edits.
const gridEvidence = new Map(
  demoProducts.map((row, index) => [
    row.id,
    {
      target: [4, 2, 6, 3][index % 4] ?? 4,
      previousPrice:
        index % 5 === 0
          ? null
          : row.price === null
            ? null
            : Math.round(row.price * ([0.9, 1.1, 1][index % 3] ?? 1) * 100) /
              100,
      history: [1, 0.85, null, 0.95, 1.05, 1].map((factor) =>
        factor === null || row.price === null
          ? null
          : Math.round(row.price * factor * 100) / 100,
      ),
    },
  ]),
);
const stockMaximum = Math.max(1, ...demoProducts.map((row) => row.onHand));
const priceMaximum = Math.max(
  1,
  ...[...gridEvidence.values()].flatMap((item) =>
    item.history.filter((value) => value !== null),
  ),
);
const historyMonths = ["May", "Jun", "Jul", "Aug", "Sep", "Oct"];

const coverageValue = (row: DemoProduct) => {
  const target = gridEvidence.get(row.id)?.target;
  return target === undefined ? null : row.onHand / target;
};
const priceChangeValue = (row: DemoProduct) => {
  const previous = gridEvidence.get(row.id)?.previousPrice;
  return row.price === null || previous == null ? null : row.price - previous;
};
const priceHistoryValue = (row: DemoProduct) =>
  gridEvidence.get(row.id)?.history.at(-1) ?? null;

export function RTableSection() {
  const [rows, setRows] = useState(demoProducts);
  const [grouped, setGrouped] = useState(false);
  const [presentation, setPresentation] = useState("visual");
  const visual = presentation === "visual";
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
              className: "w-28",
              numeric: true,
              mono: true,
              cellData: onHandData,
            }),
            cell: function OnHandCell({ row, getValue }) {
              const visual = useContext(CellPresentation);
              const value = getValue();
              const editor = (
                <EditableCell
                  value={value}
                  onSave={(onHand) =>
                    update(row.original.id, { onHand: onHand ?? 0 })
                  }
                  clipboard={specFromCellData(onHandData, row.original)}
                  config={{ type: "number", step: "1" }}
                  renderValue={(current) => (
                    <span
                      className={current === 0 ? "text-warning" : undefined}
                    >
                      {current ?? "—"}
                    </span>
                  )}
                />
              );
              return (
                <CellBar
                  value={visual ? value : null}
                  maximum={stockMaximum}
                  label={
                    visual
                      ? `On hand: ${value}; fixed scale 0–${stockMaximum}; bar capped at maximum`
                      : `On hand: ${value}`
                  }
                >
                  {editor}
                </CellBar>
              );
            },
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
          helper.accessor(coverageValue, {
            id: "coverage",
            header: "Stock / target",
            meta: attachCubbyColumnMeta<DemoProduct>({
              className: "w-32",
              numeric: true,
              mono: true,
              cellData: numberCellData("number", coverageValue),
            }),
            cell: function CoverageCell({ row }) {
              const visual = useContext(CellPresentation);
              const target = gridEvidence.get(row.original.id)?.target;
              if (target === undefined) return "—";
              const value = row.original.onHand;
              const label = `${value} / ${target}`;
              return visual ? (
                <CellBar
                  value={value}
                  maximum={target}
                  label={`${label} units; illustrative stock target; bar capped at 100%`}
                >
                  <span className="text-muted-foreground">{label}</span>
                </CellBar>
              ) : (
                <span className="text-muted-foreground">{label}</span>
              );
            },
          }),
        );
        add(
          helper.accessor(priceChangeValue, {
            id: "priceChange",
            header: "Price change",
            meta: attachCubbyColumnMeta<DemoProduct>({
              className: "w-28",
              numeric: true,
              mono: true,
              cellData: numberCellData("currency", priceChangeValue),
            }),
            cell: function PriceChangeCell({ getValue }) {
              const delta = getValue();
              if (delta === null)
                return <span className="text-muted-foreground">—</span>;
              return (
                <span
                  title="Current price minus previous observed price"
                  className="text-muted-foreground"
                >
                  {delta > 0 ? "+" : ""}
                  {formatCurrency(delta)}
                </span>
              );
            },
          }),
        );
        add(
          helper.accessor(priceHistoryValue, {
            id: "priceHistory",
            header: "May–Oct price",
            meta: attachCubbyColumnMeta<DemoProduct>({
              className: "w-44",
              numeric: true,
              mono: true,
              cellData: numberCellData("currency", priceHistoryValue),
            }),
            cell: function PriceHistoryCell({ row, getValue }) {
              const visual = useContext(CellPresentation);
              const history = gridEvidence.get(row.original.id)?.history ?? [];
              const label = history
                .map(
                  (value, index) =>
                    `${historyMonths[index]}: ${value === null ? "unknown" : formatCurrency(value)}`,
                )
                .join("; ");
              const value = getValue();
              const text = value === null ? "—" : formatCurrency(value);
              return visual ? (
                <CellSparkline
                  samples={history}
                  minimum={0}
                  maximum={priceMaximum}
                  label={label}
                >
                  <span className="text-muted-foreground">{text}</span>
                </CellSparkline>
              ) : (
                <span className="text-muted-foreground" title={label}>
                  {text}
                </span>
              );
            },
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
    initialColumnVisibility: {
      location: false,
      purchasedOn: false,
      updatedAt: false,
    },
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
    <CellPresentation.Provider value={visual}>
      <Stack gap="md">
        <p className="text-xs text-muted-foreground">
          Production lists reach RTable through <code>ListWorkbench</code> and
          the entity manifest; this one is built directly over synthetic rows.
          Double-click a cell or press Enter to edit (changes stay on this
          page), drag across cells to select a range and copy or paste it, tick
          rows for bulk actions, resize or reorder columns from the Columns
          menu, and group by domain.
        </p>
        <Row align="center" gap="md" wrap>
          <Picker
            mode="segmented"
            label="Cell presentation"
            options={PRESENTATIONS}
            value={presentation}
            onValueChange={(value) => setPresentation(value ?? "visual")}
          />
          <p className="text-xs text-muted-foreground">
            Fixed scales: stock 0–{stockMaximum}, prices {formatCurrency(0)}–
            {formatCurrency(priceMaximum)}, May–Oct 2026.
          </p>
        </Row>
        <p className="text-xs text-muted-foreground">
          Histories and stock targets are illustrative. Gaps mean unknown; price
          changes show direction, not good or bad. Edit On hand to compare the
          magnitude and target bars. History stays fixed when the current price
          changes. Presentation changes stay on this page; production
          declarations and saved views are not connected.
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
    </CellPresentation.Provider>
  );
}
