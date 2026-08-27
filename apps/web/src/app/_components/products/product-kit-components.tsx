import {
  type ProductShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { ProductPickerItemOut } from "@cubby/schemas/product";
import type {
  KitMembershipOut,
  ProductComponentOut,
} from "@cubby/schemas/product-components";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import type { RowSelectionState, Updater } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
  VerbMenuItem,
  verbBulkAction,
} from "~/app/_components/actions/action-verb-ui";
import type { BulkActionsConfig } from "~/app/_components/data-table/bulk-actions.types";
import {
  createActionsColumn,
  createCurrencyColumn,
  createImageColumn,
  createNameColumn,
  rowImages,
} from "~/app/_components/data-table/columnHelpers";
import { buildSelectColumn } from "~/app/_components/data-table/row-selection";
import RTable from "~/app/_components/data-table/Table";
import {
  type CubbyColumnDef,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/app/_components/data-table/table-features";
import { useCubbyTableLayout } from "~/app/_components/data-table/table-layout";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useEntitySelection } from "~/app/_components/hooks/useEntitySelection";
import { product as productOperations } from "~/app/products/product.functions";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";

const EMPTY_COMPONENTS: ProductComponentOut[] = [];
const EMPTY_MEMBERSHIP: KitMembershipOut[] = [];
const SEARCH_PAGE_SIZE = 50;
const TABLE_STATE = {
  pagination: { pageIndex: 0, pageSize: SEARCH_PAGE_SIZE },
} as const;

type ProductRow = {
  id: string;
  name: string;
  manufacturer: string;
  quantity: number;
  price: number | null;
  /** Live units on shelves; `null` when mixed-unit, so unanswerable. */
  onHandUnits: number | null;
  images: Array<{ id: string; url: string; filename: string }>;
};

/**
 * Where a decomposed kit's stock actually sits, said once above the table.
 *
 * A kit that has been split keeps the Expense and holds no stock of its own, so
 * its own On hand reads `—` — the honest answer for the kit, and a confusing one
 * for the reader, who wants to know whether the parts are accounted for. This
 * answers that and nothing more: it deliberately does NOT synthesise a "1
 * complete set" figure, because the parts can sit in different rooms and the
 * kit's own on-hand feeds sorting, filtering and the variance gate.
 *
 * Null (mixed-unit) is not stocked for this purpose: the count is unknown, and
 * claiming the part is accounted for would be the one wrong answer.
 */
function componentStockSummary(
  rows: readonly { onHandUnits: number | null }[],
): { text: string; tone: "positive" | "warning" } | null {
  if (rows.length === 0) return null;
  const stocked = rows.filter(
    (row) => row.onHandUnits !== null && row.onHandUnits > 0,
  ).length;
  if (stocked === 0) return null;
  return stocked === rows.length
    ? { text: "Stocked as its components", tone: "positive" }
    : {
        text: `${stocked} of ${rows.length} components stocked`,
        tone: "warning",
      };
}
type PickerRow = ProductPickerItemOut & { images: ProductRow["images"] };

function imagesFor(id: string, name: string, url: string | null) {
  return url ? [{ id: `cover:${id}`, url, filename: name }] : [];
}

function KitTable({
  rows,
  ariaLabel,
  layoutKey,
  action,
  emptyState,
  nameHeader,
  showPrice,
  showOnHand,
  bulkActions,
}: {
  rows: ProductRow[];
  ariaLabel: string;
  layoutKey: string;
  action: (row: ProductRow) => ReactNode;
  emptyState: ReactNode;
  nameHeader: "Product" | "Kit";
  showPrice: boolean;
  /** Off for the membership table: those rows are kits, not parts. */
  showOnHand: boolean;
  /**
   * Omitted by the membership table: each of its rows is a *different* kit,
   * and `detachComponents` takes one parent, so removing from N kits is N
   * calls rather than a bulk operation.
   */
  bulkActions?: BulkActionsConfig<ProductRow>;
}) {
  const selection = useEntitySelection<ProductRow>({
    entity: "product",
    bulkActions,
  });
  const helper = useMemo(() => createCubbyColumnHelper<ProductRow>(), []);
  const columns = useMemo<CubbyColumnDef<ProductRow>[]>(
    () => [
      ...selection.selectColumns,
      createImageColumn(helper, { entity: "product", getImages: rowImages }),
      createNameColumn(helper, "product", "name", {
        header: nameHeader,
      }),
      helper.accessor((row) => row.manufacturer, {
        id: "manufacturer",
        header: "Manufacturer",
        meta: {
          className: "w-40",
          mobile: { slot: "subtitle", priority: 10, label: "Maker" },
        },
        cell: (info) =>
          isUnspecifiedManufacturer(info.getValue()) ? "—" : info.getValue(),
      }),
      helper.accessor((row) => row.quantity, {
        id: "quantity",
        header: "Quantity",
        meta: {
          className: "w-24",
          numeric: true,
          mobile: { slot: "meta", priority: 20, label: "Qty" },
        },
        cell: (info) => `×${info.getValue()}`,
      }),
      ...(showOnHand
        ? [
            helper.accessor((row) => row.onHandUnits, {
              id: "onHandUnits",
              header: "On hand",
              meta: {
                className: "w-24",
                numeric: true,
                mobile: { slot: "meta", priority: 25, label: "On hand" },
              },
              // `—` only for mixed units, where no single number is true. A
              // zero is a real, load-bearing answer: that part is unaccounted.
              cell: (info) => info.getValue() ?? "—",
            }),
          ]
        : []),
      ...(showPrice
        ? [
            createCurrencyColumn(helper, "price", {
              header: "Price",
              className: "w-32",
              mobile: { slot: "meta", priority: 30 },
            }),
          ]
        : []),
      createActionsColumn(helper, "product", { extraActions: action }),
    ],
    [
      action,
      helper,
      nameHeader,
      showPrice,
      showOnHand,
      selection.selectColumns,
    ],
  );
  const layout = useCubbyTableLayout({ key: layoutKey, columns });
  const table = useCubbyTable({
    data: rows,
    columns: layout.columns,
    atoms: layout.atoms,
    meta: { defaultLayout: layout.defaultLayout },
    getRowId: (row) => row.id,
    enableRowSelection: selection.enableRowSelection,
    state: { rowSelection: selection.rowSelection },
    onRowSelectionChange: selection.onRowSelectionChange,
    initialState: TABLE_STATE,
  });
  return (
    <RTable
      table={table}
      entity="product"
      bulkActionBar={selection.renderBulkActionBar(table)}
      ariaLabel={ariaLabel}
      embedded
      emptyState={emptyState}
    />
  );
}

function AddComponentsDialog({
  open,
  onOpenChange,
  parentProductId,
  attachedIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentProductId: string;
  attachedIds: Set<string>;
}) {
  const [selected, setSelected] = useState<Map<ProductShortcode, number>>(
    new Map(),
  );
  const [searchInput, setSearchInput] = useState("");
  const [search] = useDebouncedValue(searchInput, { wait: 300 });

  const searchQuery = useQuery({
    ...productOperations.search.queryOptions({
      filters: { nameFilter: search.trim() || undefined },
      pagination: { pageIndex: 0, pageSize: SEARCH_PAGE_SIZE },
      sort: [{ orderBy: "name", direction: "asc" }],
    }),
    enabled: open,
  });
  const rows = useMemo(
    () =>
      (searchQuery.data?.items ?? [])
        .filter(
          (item) => !attachedIds.has(item.id) && item.id !== parentProductId,
        )
        .map((item) => ({
          ...item,
          images: imagesFor(item.id, item.name, item.coverImageUrl),
        })),
    [attachedIds, parentProductId, searchQuery.data?.items],
  );

  const resetAndClose = (next: boolean) => {
    if (!next) {
      setSelected(new Map());
      setSearchInput("");
    }
    onOpenChange(next);
  };
  const attach = useActionMutation({
    mutationFn: productOperations.attachComponents.mutationOptions,
    success: (result) =>
      `Added ${result.changed} component${result.changed === 1 ? "" : "s"}`,
    onSuccess: () => resetAndClose(false),
  });

  const rowSelection = useMemo<RowSelectionState>(
    () => Object.fromEntries([...selected.keys()].map((id) => [id, true])),
    [selected],
  );
  const onRowSelectionChange = (updater: Updater<RowSelectionState>) => {
    const next =
      typeof updater === "function" ? updater(rowSelection) : updater;
    setSelected((previous) => {
      const quantities = new Map(previous);
      for (const id of Object.keys(rowSelection)) {
        if (!next[id]) quantities.delete(parseShortcodeFor("product", id));
      }
      for (const id of Object.keys(next)) {
        if (next[id]) {
          const productId = parseShortcodeFor("product", id);
          quantities.set(productId, quantities.get(productId) ?? 1);
        }
      }
      return quantities;
    });
  };

  const helper = useMemo(() => createCubbyColumnHelper<PickerRow>(), []);
  const columns = useMemo<CubbyColumnDef<PickerRow>[]>(
    () => [
      buildSelectColumn<PickerRow>(),
      createImageColumn(helper, { entity: "product", getImages: rowImages }),
      createNameColumn(helper, "product", "name", { header: "Product" }),
      helper.accessor((row) => row.manufacturer, {
        id: "manufacturer",
        header: "Manufacturer",
        meta: {
          className: "w-40",
          mobile: { slot: "subtitle", label: "Maker" },
        },
        cell: (info) =>
          isUnspecifiedManufacturer(info.getValue()) ? "—" : info.getValue(),
      }),
      createCurrencyColumn(helper, "price", {
        header: "Price",
        className: "w-28",
        mobile: { slot: "meta", priority: 20 },
      }),
      helper.accessor((row) => selected.get(row.id), {
        id: "quantity",
        header: "Quantity",
        enableSorting: false,
        meta: {
          className: "w-24",
          numeric: true,
          mobile: {
            slot: "meta",
            priority: 30,
            interactive: true,
            label: "Qty",
          },
        },
        cell: (info) => {
          const quantity = selected.get(info.row.original.id);
          return quantity === undefined ? null : (
            <Input
              type="number"
              min={1}
              max={9999}
              value={quantity}
              aria-label={`Quantity of ${info.row.original.name}`}
              className="h-7 w-20"
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => {
                const next = Math.max(1, Number(event.target.value) || 1);
                setSelected((previous) => {
                  const quantities = new Map(previous);
                  quantities.set(info.row.original.id, next);
                  return quantities;
                });
              }}
            />
          );
        },
      }),
    ],
    [helper, selected],
  );
  const layout = useCubbyTableLayout({
    key: "product:component-picker",
    columns,
  });
  const table = useCubbyTable({
    data: rows,
    columns: layout.columns,
    atoms: layout.atoms,
    meta: { defaultLayout: layout.defaultLayout },
    getRowId: (row) => row.id,
    enableRowSelection: true,
    state: { rowSelection },
    onRowSelectionChange,
    initialState: TABLE_STATE,
  });

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Add components</DialogTitle>
          <DialogDescription>
            Record what this kit or multi-pack is made of, and how many of each.
            This kit keeps its own Expense and its own UPC/model/ASIN —
            attaching creates no money and moves no barcode.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search products…"
        />
        <div className="max-h-96 overflow-y-auto">
          <RTable
            table={table}
            entity="product"
            ariaLabel="Products available as kit components"
            embedded
            isLoading={searchQuery.isPending}
            emptyState={
              <Empty variant="minimal" className="py-6">
                <EmptyTitle>No products found</EmptyTitle>
                <EmptyDescription>
                  Adjust the search, or every match is already a component.
                </EmptyDescription>
              </Empty>
            }
          />
        </div>
        <DialogFooter>
          <Description size="xs" className="mr-auto">
            {selected.size} selected
          </Description>
          <Button variant="outline" onClick={() => resetAndClose(false)}>
            Cancel
          </Button>
          <Button
            disabled={selected.size === 0 || attach.isPending}
            onClick={() =>
              attach.mutate({
                parentProductId,
                components: [...selected].map(([productId, quantity]) => ({
                  productId,
                  quantity,
                })),
              })
            }
          >
            {attach.isPending ? "Adding..." : `Add ${selected.size}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProductKitComponents({ productId }: { productId: string }) {
  const [addOpen, setAddOpen] = useState(false);
  const componentsQuery = useQuery(
    productOperations.components.queryOptions({ parentProductId: productId }),
  );
  const membershipQuery = useQuery(
    productOperations.kitMembership.queryOptions({ productId }),
  );
  const components = componentsQuery.data ?? EMPTY_COMPONENTS;
  const membership = membershipQuery.data ?? EMPTY_MEMBERSHIP;
  const componentRows = useMemo<ProductRow[]>(
    () =>
      components.map((item) => ({
        id: item.productId,
        name: item.productName,
        manufacturer: item.manufacturer,
        quantity: item.quantity,
        price: item.price,
        onHandUnits: item.onHandUnits,
        images: imagesFor(item.productId, item.productName, item.coverImageUrl),
      })),
    [components],
  );
  const membershipRows = useMemo<ProductRow[]>(
    () =>
      membership.map((item) => ({
        id: item.parentProductId,
        name: item.parentProductName,
        manufacturer: item.manufacturer,
        quantity: item.quantity,
        price: item.price,
        // The membership table lists KITS this product sits inside; their own
        // stock is a different question, and `showOnHand` keeps it off-screen.
        onHandUnits: null,
        images: imagesFor(
          item.parentProductId,
          item.parentProductName,
          item.coverImageUrl,
        ),
      })),
    [membership],
  );

  const stockSummary = useMemo(
    () => componentStockSummary(componentRows),
    [componentRows],
  );

  const detachComponent = useActionMutation({
    mutationFn: productOperations.detachComponents.mutationOptions,
    success: "Component removed",
  });
  const detachMembership = useActionMutation({
    mutationFn: productOperations.detachComponents.mutationOptions,
    success: "Removed from kit",
  });
  // The one direction that is already a bulk operation:
  // `detachComponents({ parentProductId, componentProductIds[] })` fixes the
  // parent, and this table's rows are all parts of it. The membership table is
  // the inverse — each row a different parent — so it gets no bulk action.
  // `mutateAsync` is referentially stable; the mutation object is not.
  const detachComponentAsync = detachComponent.mutateAsync;
  const componentBulkActions = useMemo(
    () => ({
      actions: [
        verbBulkAction<ProductRow>("removeComponent", {
          minSelection: 1,
          onExecute: async (rows) => {
            await detachComponentAsync({
              parentProductId: productId,
              componentProductIds: rows.map((row) => row.original.id),
            });
            return { success: true };
          },
        }),
      ],
    }),
    [productId, detachComponentAsync],
  );

  const componentAction = useMemo(
    () => (row: ProductRow) => (
      <VerbMenuItem
        verb="removeComponent"
        disabled={detachComponent.isPending}
        onSelect={(event) => {
          event.stopPropagation();
          detachComponent.mutate({
            parentProductId: productId,
            componentProductIds: [row.id],
          });
        }}
      />
    ),
    [detachComponent, productId],
  );
  const membershipAction = useMemo(
    () => (row: ProductRow) => (
      <VerbMenuItem
        verb="removeFromKit"
        disabled={detachMembership.isPending}
        onSelect={(event) => {
          event.stopPropagation();
          detachMembership.mutate({
            parentProductId: row.id,
            componentProductIds: [productId],
          });
        }}
      />
    ),
    [detachMembership, productId],
  );

  if (componentsQuery.isPending || membershipQuery.isPending) {
    return <Description>Loading kit composition…</Description>;
  }

  return (
    <Stack gap="md">
      <Stack gap="sm">
        <Row align="center" justify="between" gap="sm">
          <Stack gap="xs">
            <Description size="xs">
              What this kit or multi-pack is made of. It keeps its own Expense —
              components are never split into per-component charges.
            </Description>
            {stockSummary && (
              <Badge variant={stockSummary.tone}>{stockSummary.text}</Badge>
            )}
          </Stack>
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <Plus />
            Add component
          </Button>
        </Row>
        <KitTable
          rows={componentRows}
          ariaLabel="Kit components"
          layoutKey="product:kit-components"
          action={componentAction}
          bulkActions={componentBulkActions}
          nameHeader="Product"
          showPrice
          showOnHand
          emptyState={
            <Empty variant="minimal" className="py-6">
              <EmptyHeader>
                <EmptyTitle>Not a kit</EmptyTitle>
                <EmptyDescription>
                  Add the products this one contains — a 4-pack of one part is
                  one component at quantity 4.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          }
        />
      </Stack>

      {membership.length > 0 && (
        <Stack gap="sm">
          <Description size="xs">
            Kits this product is listed inside.
          </Description>
          <KitTable
            rows={membershipRows}
            ariaLabel="Kit memberships"
            layoutKey="product:kit-memberships"
            action={membershipAction}
            nameHeader="Kit"
            showPrice
            showOnHand={false}
            emptyState={null}
          />
        </Stack>
      )}

      <AddComponentsDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        parentProductId={productId}
        attachedIds={new Set(components.map((item) => item.productId))}
      />
    </Stack>
  );
}
