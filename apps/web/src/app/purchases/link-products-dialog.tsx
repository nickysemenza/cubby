import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { ProductPickerItemOut } from "@cubby/schemas/product";
import type { PurchaseOut } from "@cubby/schemas/purchase";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import {
  type RowSelectionState,
  type Updater,
  useTable,
} from "@tanstack/react-table";
import { Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
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
import { Row } from "~/components/layout";
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
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { useTRPC } from "~/integrations/trpc/react";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { purchaseLabel } from "~/lib/purchase-label";
import { purchaseProductMutationInvalidateKeys } from "~/lib/query-keys";

const SEARCH_PAGE_SIZE = 50;
type PickerRow = ProductPickerItemOut & {
  images: Array<{ id: string; url: string; filename: string }>;
};

export function LinkProductsDialog({
  open,
  onOpenChange,
  purchase,
  attachedIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purchase: PurchaseOut;
  attachedIds: Set<string>;
}) {
  const api = useTRPC();
  const [selected, setSelected] = useState<Set<ProductShortcode>>(new Set());
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
  const rows = useMemo<PickerRow[]>(
    () =>
      (searchQuery.data?.items ?? [])
        .filter((item) => !attachedIds.has(item.id))
        .map((item) => ({
          ...item,
          images: item.coverImageUrl
            ? [
                {
                  id: `cover:${item.id}`,
                  url: item.coverImageUrl,
                  filename: item.name,
                },
              ]
            : [],
        })),
    [attachedIds, searchQuery.data?.items],
  );

  const resetAndClose = (next: boolean) => {
    if (!next) {
      setSelected(new Set());
      setSearchInput("");
      lastSelectedIdRef.current = null;
    }
    onOpenChange(next);
  };
  const attach = useActionMutation({
    mutationFn: api.purchase.attachProducts.mutationOptions,
    success: (result) =>
      `Attached ${result.changed} product${result.changed === 1 ? "" : "s"}`,
    invalidateKeys: purchaseProductMutationInvalidateKeys,
    onSuccess: () => resetAndClose(false),
  });

  const rowSelection = useMemo<RowSelectionState>(
    () => Object.fromEntries([...selected].map((id) => [id, true])),
    [selected],
  );
  const onRowSelectionChange = (updater: Updater<RowSelectionState>) => {
    const next =
      typeof updater === "function" ? updater(rowSelection) : updater;
    setSelected(
      new Set(
        Object.entries(next)
          .filter(([, value]) => value)
          .map(([id]) => id as ProductShortcode),
      ),
    );
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
        mobile: { slot: "meta", priority: 20 },
      }),
    ],
    [helper],
  );
  const table = useTable<typeof cubbyTableFeatures, PickerRow>({
    features: cubbyTableFeatures,
    data: rows,
    columns,
    getRowId: (row) => row.id,
    enableRowSelection: true,
    state: { rowSelection },
    onRowSelectionChange,
    initialState: { pagination: { pageIndex: 0, pageSize: SEARCH_PAGE_SIZE } },
  });

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            Attach products to {purchaseLabel(purchase)}
          </DialogTitle>
          <DialogDescription>
            Record which products this purchase bought. The link carries no
            money or quantity — spend stays on the purchase&apos;s Expenses.
          </DialogDescription>
        </DialogHeader>
        <Row align="center" gap="sm">
          <Search
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search products…"
          />
        </Row>
        <div className="max-h-96 overflow-y-auto">
          <RTable
            table={table}
            entity="product"
            ariaLabel="Products available to attach"
            sizingKey="purchase:product-picker"
            embedded
            isLoading={searchQuery.isPending}
            emptyState={
              <Empty variant="minimal" className="py-6">
                <EmptyTitle>No products found</EmptyTitle>
                <EmptyDescription>
                  Adjust the search, or every match is already attached.
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
                purchaseId: purchase.id,
                productIds: [...selected],
              })
            }
          >
            {attach.isPending ? "Attaching..." : `Attach ${selected.size}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
