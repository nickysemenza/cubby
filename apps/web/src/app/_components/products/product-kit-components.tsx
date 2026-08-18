import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { ProductPickerItemOut } from "@cubby/schemas/product";
import type {
  KitMembershipOut,
  ProductComponentOut,
} from "@cubby/schemas/product-components";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import {
  type RowSelectionState,
  type Updater,
  useTable,
} from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { VerbMenuItem } from "~/app/_components/actions/action-verb-ui";
import {
  createActionsColumn,
  createCurrencyColumn,
  createImageColumn,
  createNameColumn,
} from "~/app/_components/data-table/columnHelpers";
import { buildSelectColumn } from "~/app/_components/data-table/row-selection";
import RTable from "~/app/_components/data-table/Table";
import {
  type CubbyColumnDef,
  createCubbyColumnHelper,
  cubbyTableFeatures,
} from "~/app/_components/data-table/table-features";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Row, Stack } from "~/components/layout";
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
import { useTRPC } from "~/integrations/trpc/react";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { productComponentMutationInvalidateKeys } from "~/lib/query-keys";

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
  images: Array<{ id: string; url: string; filename: string }>;
};
type PickerRow = ProductPickerItemOut & { images: ProductRow["images"] };

function imagesFor(id: string, name: string, url: string | null) {
  return url ? [{ id: `cover:${id}`, url, filename: name }] : [];
}

function KitTable({
  rows,
  ariaLabel,
  sizingKey,
  action,
  emptyState,
  nameHeader,
  showPrice,
}: {
  rows: ProductRow[];
  ariaLabel: string;
  sizingKey: string;
  action: (row: ProductRow) => ReactNode;
  emptyState: ReactNode;
  nameHeader: "Product" | "Kit";
  showPrice: boolean;
}) {
  const helper = useMemo(() => createCubbyColumnHelper<ProductRow>(), []);
  const columns = useMemo<CubbyColumnDef<ProductRow>[]>(
    () => [
      createImageColumn(helper, { entity: "product" }),
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
    [action, helper, nameHeader, showPrice],
  );
  const table = useTable<typeof cubbyTableFeatures, ProductRow>({
    features: cubbyTableFeatures,
    data: rows,
    columns,
    getRowId: (row) => row.id,
    initialState: TABLE_STATE,
  });
  return (
    <RTable
      table={table}
      entity="product"
      ariaLabel={ariaLabel}
      sizingKey={sizingKey}
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
  const api = useTRPC();
  const [selected, setSelected] = useState<Map<ProductShortcode, number>>(
    new Map(),
  );
  const [searchInput, setSearchInput] = useState("");
  const [search] = useDebouncedValue(searchInput, { wait: 300 });
  const lastSelectedIdRef = useRef<string | null>(null);
  const shiftKeyRef = useRef(false);

  const searchQuery = useQuery({
    ...api.product.search.queryOptions({
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
      lastSelectedIdRef.current = null;
    }
    onOpenChange(next);
  };
  const attach = useActionMutation({
    mutationFn: api.product.attachComponents.mutationOptions,
    success: (result) =>
      `Added ${result.changed} component${result.changed === 1 ? "" : "s"}`,
    invalidateKeys: productComponentMutationInvalidateKeys,
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
        if (!next[id]) quantities.delete(id as ProductShortcode);
      }
      for (const id of Object.keys(next)) {
        if (next[id]) {
          const productId = id as ProductShortcode;
          quantities.set(productId, quantities.get(productId) ?? 1);
        }
      }
      return quantities;
    });
  };

  const helper = useMemo(() => createCubbyColumnHelper<PickerRow>(), []);
  const columns = useMemo<CubbyColumnDef<PickerRow>[]>(
    () => [
      buildSelectColumn<PickerRow>(lastSelectedIdRef, shiftKeyRef),
      createImageColumn(helper, { entity: "product" }),
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
  const table = useTable<typeof cubbyTableFeatures, PickerRow>({
    features: cubbyTableFeatures,
    data: rows,
    columns,
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
            sizingKey="product:component-picker"
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
  const api = useTRPC();
  const [addOpen, setAddOpen] = useState(false);
  const componentsQuery = useQuery(
    api.product.components.queryOptions({ parentProductId: productId }),
  );
  const membershipQuery = useQuery(
    api.product.kitMembership.queryOptions({ productId }),
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
        images: imagesFor(
          item.parentProductId,
          item.parentProductName,
          item.coverImageUrl,
        ),
      })),
    [membership],
  );

  const detachComponent = useActionMutation({
    mutationFn: api.product.detachComponents.mutationOptions,
    success: "Component removed",
    invalidateKeys: productComponentMutationInvalidateKeys,
  });
  const detachMembership = useActionMutation({
    mutationFn: api.product.detachComponents.mutationOptions,
    success: "Removed from kit",
    invalidateKeys: productComponentMutationInvalidateKeys,
  });
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
          <Description size="xs">
            What this kit or multi-pack is made of. It keeps its own Expense —
            components are never split into per-component charges.
          </Description>
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <Plus />
            Add component
          </Button>
        </Row>
        <KitTable
          rows={componentRows}
          ariaLabel="Kit components"
          sizingKey="product:kit-components"
          action={componentAction}
          nameHeader="Product"
          showPrice
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
            sizingKey="product:kit-memberships"
            action={membershipAction}
            nameHeader="Kit"
            showPrice
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
