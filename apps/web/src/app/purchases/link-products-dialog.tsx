import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { PurchaseOut } from "@cubby/schemas/purchase";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
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
import { purchaseLabel } from "~/lib/purchase-label";
import { purchaseProductMutationInvalidateKeys } from "~/lib/query-keys";

/** Generous typeahead page within MAX_PAGE_SIZE; the search box narrows it further. */
const SEARCH_PAGE_SIZE = 50;

/**
 * Attach Products to a Purchase — the provenance link for lump-sum/installment
 * orders whose Expenses are `lineBasis: "allocation"` and so can never carry a
 * `productId` (see `packages/schemas/src/purchase.ts`). Attaching records
 * which goods this order bought; it changes no spend, quantity, or inventory.
 */
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

  const searchQuery = useQuery({
    ...api.product.search.queryOptions({
      filters: { nameFilter: search.trim() || undefined },
      pagination: { pageIndex: 0, pageSize: SEARCH_PAGE_SIZE },
      sort: [{ orderBy: "name", direction: "asc" }],
    }),
    enabled: open,
  });

  const results = (searchQuery.data?.items ?? []).filter(
    (item) => !attachedIds.has(item.id),
  );

  // The ONLY close path. Every dismissal — Escape, overlay click, Cancel, and a
  // successful attach — goes through here, so the next open can't inherit a
  // stale selection or search term from the last one.
  const resetAndClose = (next: boolean) => {
    if (!next) {
      setSelected(new Set());
      setSearchInput("");
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

  const toggle = (id: ProductShortcode, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            Attach products to {purchaseLabel(purchase)}
          </DialogTitle>
          <DialogDescription>
            Record which products this purchase bought. The link carries no
            money or quantity — spend always stays on the purchase&apos;s
            Expenses.
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

        {searchQuery.isPending ? (
          <Description>Loading products…</Description>
        ) : results.length === 0 ? (
          <Empty variant="minimal" className="py-6">
            <EmptyTitle>No products found</EmptyTitle>
            <EmptyDescription>
              Adjust the search, or every match is already attached.
            </EmptyDescription>
          </Empty>
        ) : (
          <Stack gap="xs" className="max-h-96 overflow-y-auto">
            {results.map((item) => (
              <Row
                as="label"
                key={item.id}
                align="center"
                gap="sm"
                className="cursor-pointer border border-[var(--border)] p-4"
              >
                <Checkbox
                  checked={selected.has(item.id)}
                  onCheckedChange={(checked) =>
                    toggle(item.id, checked === true)
                  }
                />
                <div className="min-w-0">
                  <EntityInlineLink
                    entity="product"
                    data={{
                      id: item.id,
                      name: item.name,
                      manufacturer: item.manufacturer,
                    }}
                    truncate
                  />
                </div>
              </Row>
            ))}
          </Stack>
        )}

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
            {attach.isPending
              ? "Attaching..."
              : `Attach ${selected.size || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
