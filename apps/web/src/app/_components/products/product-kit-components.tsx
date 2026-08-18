import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type {
  KitMembershipOut,
  ProductComponentOut,
} from "@cubby/schemas/product-components";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
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
import { formatCurrency } from "~/lib/utils";

const EMPTY_COMPONENTS: ProductComponentOut[] = [];
const EMPTY_MEMBERSHIP: KitMembershipOut[] = [];
const SEARCH_PAGE_SIZE = 50;

function componentSubtitle(item: ProductComponentOut): string | null {
  const parts = [
    isUnspecifiedManufacturer(item.manufacturer) ? null : item.manufacturer,
    // Each component's OWN price (its own purchase/override history), never a
    // share of the kit's — the kit keeps its own Expense, never split.
    item.price != null ? `${formatCurrency(item.price)} on its own` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function ComponentRow({
  parentProductId,
  item,
}: {
  parentProductId: string;
  item: ProductComponentOut;
}) {
  const api = useTRPC();
  const detach = useActionMutation({
    mutationFn: api.product.detachComponents.mutationOptions,
    success: `Removed ${item.productName}`,
    invalidateKeys: productComponentMutationInvalidateKeys,
  });
  const subtitle = componentSubtitle(item);

  return (
    <Row
      align="center"
      justify="between"
      gap="md"
      className="border border-[var(--border)] p-4"
    >
      <Stack gap="xs" className="min-w-0">
        <Row align="center" gap="sm">
          <EntityInlineLink
            entity="product"
            data={{
              id: item.productId,
              name: item.productName,
              manufacturer: item.manufacturer,
            }}
            truncate
          />
          <Badge variant="outline">×{item.quantity}</Badge>
        </Row>
        {subtitle && <Description size="xs">{subtitle}</Description>}
      </Stack>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${item.productName}`}
        disabled={detach.isPending}
        onClick={() =>
          detach.mutate({
            parentProductId,
            componentProductIds: [item.productId],
          })
        }
      >
        <Trash2 />
      </Button>
    </Row>
  );
}

function MembershipRow({
  productId,
  item,
}: {
  productId: string;
  item: KitMembershipOut;
}) {
  const api = useTRPC();
  const detach = useActionMutation({
    mutationFn: api.product.detachComponents.mutationOptions,
    success: `Removed from ${item.parentProductName}`,
    invalidateKeys: productComponentMutationInvalidateKeys,
  });

  return (
    <Row
      align="center"
      justify="between"
      gap="md"
      className="border border-[var(--border)] p-4"
    >
      <Stack gap="xs" className="min-w-0">
        <Row align="center" gap="sm">
          <EntityInlineLink
            entity="product"
            data={{
              id: item.parentProductId,
              name: item.parentProductName,
              manufacturer: item.manufacturer,
            }}
            truncate
          />
          <Badge variant="outline">×{item.quantity}</Badge>
        </Row>
      </Stack>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove from ${item.parentProductName}`}
        disabled={detach.isPending}
        onClick={() =>
          detach.mutate({
            parentProductId: item.parentProductId,
            componentProductIds: [productId],
          })
        }
      >
        <Trash2 />
      </Button>
    </Row>
  );
}

/**
 * Add components to a kit — search for a Product and set how many of it the
 * kit contains. Mirrors `LinkProductsDialog` (purchases), plus a per-row
 * quantity: `ProductComponent` carries one, `PurchaseProduct` doesn't.
 */
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

  const searchQuery = useQuery({
    ...api.product.search.queryOptions({
      filters: { nameFilter: search.trim() || undefined },
      pagination: { pageIndex: 0, pageSize: SEARCH_PAGE_SIZE },
      sort: [{ orderBy: "name", direction: "asc" }],
    }),
    enabled: open,
  });

  const results = (searchQuery.data?.items ?? []).filter(
    (item) => !attachedIds.has(item.id) && item.id !== parentProductId,
  );

  const resetAndClose = (next: boolean) => {
    if (!next) {
      setSelected(new Map());
      setSearchInput("");
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

  const toggle = (id: ProductShortcode, checked: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (checked) next.set(id, next.get(id) ?? 1);
      else next.delete(id);
      return next;
    });
  };

  const setQuantity = (id: ProductShortcode, quantity: number) => {
    setSelected((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.set(id, quantity);
      return next;
    });
  };

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

        {searchQuery.isPending ? (
          <Description>Loading products…</Description>
        ) : results.length === 0 ? (
          <Empty variant="minimal" className="py-6">
            <EmptyTitle>No products found</EmptyTitle>
            <EmptyDescription>
              Adjust the search, or every match is already a component.
            </EmptyDescription>
          </Empty>
        ) : (
          <Stack gap="xs" className="max-h-96 overflow-y-auto">
            {results.map((item) => {
              const quantity = selected.get(item.id);
              return (
                <Row
                  key={item.id}
                  align="center"
                  gap="sm"
                  className="border border-[var(--border)] p-4"
                >
                  <Checkbox
                    checked={quantity !== undefined}
                    onCheckedChange={(checked) =>
                      toggle(item.id, checked === true)
                    }
                  />
                  <div className="min-w-0 flex-1">
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
                  {quantity !== undefined && (
                    <Input
                      type="number"
                      min={1}
                      max={9999}
                      value={quantity}
                      aria-label={`Quantity of ${item.name}`}
                      onChange={(event) =>
                        setQuantity(
                          item.id,
                          Math.max(1, Number(event.target.value) || 1),
                        )
                      }
                      className="w-20"
                    />
                  )}
                </Row>
              );
            })}
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
                parentProductId,
                components: [...selected].map(([productId, quantity]) => ({
                  productId,
                  quantity,
                })),
              })
            }
          >
            {attach.isPending
              ? "Adding..."
              : `Add ${selected.size || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Kit composition, both directions: what this Product is made of (if it's a
 * kit or multi-pack), and every kit it's listed inside (if it's a part). See
 * `packages/schemas/src/product-components.ts` for what the edge means — the
 * kit keeps its own Expense and its own UPC/model/ASIN; this table records
 * composition only, never money or identity.
 */
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
        {components.length === 0 ? (
          <Empty variant="minimal" className="py-6">
            <EmptyHeader>
              <EmptyTitle>Not a kit</EmptyTitle>
              <EmptyDescription>
                Add the products this one contains — a 4-pack of one part is one
                component at quantity 4.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Stack gap="xs">
            {components.map((item) => (
              <ComponentRow
                key={item.productId}
                parentProductId={productId}
                item={item}
              />
            ))}
          </Stack>
        )}
      </Stack>

      {membership.length > 0 && (
        <Stack gap="sm">
          <Description size="xs">
            Kits this product is listed inside.
          </Description>
          <Stack gap="xs">
            {membership.map((item) => (
              <MembershipRow
                key={item.parentProductId}
                productId={productId}
                item={item}
              />
            ))}
          </Stack>
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
