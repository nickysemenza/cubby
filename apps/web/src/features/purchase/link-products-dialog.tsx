import { fieldValueOf } from "@cubby/schemas/field-envelope";
import {
  type ProductShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { purchaseLinkProductCandidate } from "@cubby/schemas/purchase";
import { countLabel } from "@cubby/shared/pluralize";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { RowSelectionState, Updater } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import type { z } from "zod";

import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import {
  createImageColumn,
  createNameColumn,
  rowImages,
} from "~/entity/table/column-helpers";
import {
  ListWorkbench,
  useBoundedListWorkbench,
} from "~/entity/table/list-workbench";
import { purchase as purchaseOperations } from "~/integrations/tanstack-query/generated/catalog/purchase.gen";
import { isUnknownBrandName } from "~/lib/brand-name-utils";
import { formatCurrency } from "~/lib/number-format";
import { purchaseLabel } from "~/lib/purchase-label";
import { buildSelectColumn } from "~/ui/data-table/row-selection";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { FieldRecordValue } from "~/ui/derived/record-value";
import { EmptyState } from "~/ui/feedback/empty-state";
import { Row } from "~/ui/layout";
import { Overlay } from "~/ui/overlays/overlay";
import { Description } from "~/ui/primitives/description";
import { Input } from "~/ui/primitives/input";
import { NoneValue } from "~/ui/primitives/none-value";

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
    success: (result) => `Attached ${countLabel(result.changed, "product")}`,
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
          helper.accessor((row) => fieldValueOf(row.fields.brandName), {
            id: "brandName",
            header: "Manufacturer",
            meta: {
              className: "w-40",
              mobile: { slot: "subtitle", label: "Maker" },
            },
            cell: (info) => (
              <FieldRecordValue record={info.row.original} field="brandName">
                {isUnknownBrandName(info.getValue()) ? "—" : info.getValue()}
              </FieldRecordValue>
            ),
          }),
        );
        add(
          helper.accessor((row) => fieldValueOf(row.fields.price), {
            id: "price",
            header: "Price",
            meta: { numeric: true, mobile: { slot: "meta", priority: 20 } },
            cell: (info) => {
              const value = info.getValue();
              return (
                <FieldRecordValue record={info.row.original} field="price">
                  {value === null ? <NoneValue /> : formatCurrency(value)}
                </FieldRecordValue>
              );
            },
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
    <Overlay
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
            <EmptyState
              size="page"
              description={searchQuery.data?.message ?? "Nothing to attach."}
            >
              No products found
            </EmptyState>
          }
        />
      </div>
    </Overlay>
  );
}

type PurchaseOut = DetailRecordOf<"purchase">;
