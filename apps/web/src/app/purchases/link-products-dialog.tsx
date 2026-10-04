import {
  type ProductShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type {
  PurchaseOut,
  purchaseLinkProductCandidate,
} from "@cubby/schemas/purchase";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { RowSelectionState, Updater } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import type { z } from "zod";

import { purchase as purchaseOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { purchaseLabel } from "~/lib/purchase-label";
import {
  createCurrencyColumn,
  createImageColumn,
  createNameColumn,
  rowImages,
} from "~/ui/data-table/columnHelpers";
import {
  ListWorkbench,
  useBoundedListWorkbench,
} from "~/ui/data-table/ListWorkbench";
import { buildSelectColumn } from "~/ui/data-table/row-selection";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { WorkflowDialog } from "~/ui/dialogs/workflow-dialog";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Row } from "~/ui/layout";
import { Description } from "~/ui/primitives/description";
import { Empty, EmptyDescription, EmptyTitle } from "~/ui/primitives/empty";
import { Input } from "~/ui/primitives/input";

const isRowSelectionUpdater = (
  value: Updater<RowSelectionState>,
): value is (previous: RowSelectionState) => RowSelectionState =>
  typeof value === "function";

const SEARCH_PAGE_SIZE = 50;
type PickerRow = z.output<typeof purchaseLinkProductCandidate> & {
  images: Array<{ id: string; url: string; filename: string }>;
};

export function LinkProductsDialog({
  open,
  onOpenChange,
  purchase,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purchase: PurchaseOut;
}) {
  const [selected, setSelected] = useState<Set<ProductShortcode>>(new Set());
  const [searchInput, setSearchInput] = useState("");
  const [search] = useDebouncedValue(searchInput, { wait: 300 });

  // The candidates — a product search minus what is already attached — are the server's
  // (`purchase.linkProductCandidates`).
  const searchQuery = useQuery({
    ...purchaseOperations.linkProductCandidates.queryOptions({
      purchaseId: purchase.id,
      search,
    }),
    enabled: open,
    // Candidates are what attaching just changed: never trust a cached list across a reopen.
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
  const rows = useMemo<PickerRow[]>(
    () =>
      (searchQuery.data?.candidates ?? []).map((item) => ({
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
    [searchQuery.data?.candidates],
  );

  const resetAndClose = (next: boolean) => {
    if (!next) {
      setSelected(new Set());
      setSearchInput("");
    }
    onOpenChange(next);
  };
  const attach = useActionMutation({
    mutationFn: purchaseOperations.attachProducts.mutationOptions,
    success: (result) =>
      `Attached ${result.changed} product${result.changed === 1 ? "" : "s"}`,
    onSuccess: () => resetAndClose(false),
  });

  const rowSelection = useMemo<RowSelectionState>(
    () => Object.fromEntries([...selected].map((id) => [id, true])),
    [selected],
  );
  const onRowSelectionChange = (updater: Updater<RowSelectionState>) => {
    const next = isRowSelectionUpdater(updater)
      ? updater(rowSelection)
      : updater;
    setSelected(
      new Set(
        Object.entries(next)
          .filter(([, value]) => value)
          .map(([id]) => parseShortcodeFor("product", id)),
      ),
    );
  };

  const helper = useMemo(() => createCubbyColumnHelper<PickerRow>(), []);
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<PickerRow>((add) => {
        add(buildSelectColumn<PickerRow>());
        add(
          createImageColumn(helper, {
            entity: "product",
            getImages: rowImages,
          }),
        );
        add(createNameColumn(helper, "product", "name", { header: "Product" }));
        add(
          helper.accessor((row) => row.manufacturer, {
            id: "manufacturer",
            header: "Manufacturer",
            meta: {
              className: "w-40",
              mobile: { slot: "subtitle", label: "Maker" },
            },
            cell: (info) =>
              isUnspecifiedManufacturer(info.getValue())
                ? "—"
                : info.getValue(),
          }),
        );
        add(
          createCurrencyColumn(helper, "price", {
            header: "Price",
            mobile: { slot: "meta", priority: 20 },
          }),
        );
      }),
    [helper],
  );
  const workbench = useBoundedListWorkbench({
    entity: "product",
    data: rows,
    columns,
    isLoading: searchQuery.isPending,
    getRowId: (row) => row.id,
    enableRowSelection: true,
    state: { rowSelection },
    onRowSelectionChange,
    initialState: {
      pagination: { pageIndex: 0, pageSize: SEARCH_PAGE_SIZE },
    },
  });

  return (
    <WorkflowDialog
      open={open}
      onOpenChange={resetAndClose}
      size="lg"
      title={`Attach products to ${purchaseLabel(purchase)}`}
      description={
        searchQuery.data?.note ?? "Record which products this purchase bought."
      }
      summary={
        <Description size="xs" className="mr-auto">
          {selected.size} selected
        </Description>
      }
      onCancel={() => resetAndClose(false)}
      primary={{
        label: `Attach ${selected.size}`,
        pendingLabel: "Attaching...",
        pending: attach.isPending,
        disabled: selected.size === 0,
        onClick: () =>
          attach.mutate({
            purchaseId: purchase.id,
            productIds: [...selected],
          }),
      }}
    >
      <Row align="center" gap="sm">
        <MagnifyingGlassIcon
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
        <ListWorkbench
          model={workbench}
          mode="embedded"
          ariaLabel="Products available to attach"
          emptyState={
            <Empty variant="minimal" className="py-6">
              <EmptyTitle>No products found</EmptyTitle>
              <EmptyDescription>
                {searchQuery.data?.message ?? "Nothing to attach."}
              </EmptyDescription>
            </Empty>
          }
        />
      </div>
    </WorkflowDialog>
  );
}
