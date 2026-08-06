import type { PurchaseProductOut } from "@cubby/schemas/purchase";
import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { useTRPC } from "~/integrations/trpc/react";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { purchaseProductMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";

const EMPTY_PRODUCTS: PurchaseProductOut[] = [];

function purchaseProductSubtitle(item: PurchaseProductOut): string | null {
  const parts = [
    isUnspecifiedManufacturer(item.manufacturer) ? null : item.manufacturer,
    item.price != null ? formatCurrency(item.price) : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function PurchaseProductRow({
  purchaseId,
  item,
}: {
  purchaseId: string;
  item: PurchaseProductOut;
}) {
  const api = useTRPC();
  const detach = useActionMutation({
    mutationFn: api.purchase.detachProducts.mutationOptions,
    success: `Removed ${item.productName} from this purchase`,
    invalidateKeys: purchaseProductMutationInvalidateKeys,
  });
  const subtitle = purchaseProductSubtitle(item);

  return (
    <Row
      align="center"
      justify="between"
      gap="md"
      className="border border-[var(--border)] p-4"
    >
      <Stack gap="xs" className="min-w-0">
        <EntityInlineLink
          entity="product"
          data={{
            id: item.productId,
            name: item.productName,
            manufacturer: item.manufacturer,
          }}
          truncate
        />
        {subtitle && <Description size="xs">{subtitle}</Description>}
      </Stack>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${item.productName} from this purchase`}
        disabled={detach.isPending}
        onClick={() =>
          detach.mutate({ purchaseId, productIds: [item.productId] })
        }
      >
        <Trash2 />
      </Button>
    </Row>
  );
}

/**
 * The Products a Purchase bought — the UI for `PurchaseProduct`, which exists
 * because a lump-sum/installment Purchase's Expenses are `lineBasis:
 * "allocation"` and can never carry a `productId` (see
 * `packages/schemas/src/purchase.ts`). This link carries no money and no
 * quantity; it is a provenance pointer, not a second spend path.
 */
export function PurchaseProductsTable({ purchaseId }: { purchaseId: string }) {
  const api = useTRPC();
  const query = useQuery(api.purchase.products.queryOptions({ purchaseId }));
  const items = query.data ?? EMPTY_PRODUCTS;

  if (query.isPending) {
    return <Description>Loading products…</Description>;
  }

  if (items.length === 0) {
    return (
      <Empty variant="minimal" className="py-6">
        <EmptyHeader>
          <EmptyTitle>No products linked</EmptyTitle>
          <EmptyDescription>
            Attach the products this purchase bought — most useful for lump-sum
            or installment orders whose expenses can&apos;t carry a product.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Stack gap="xs">
      {items.map((item) => (
        <PurchaseProductRow
          key={item.productId}
          purchaseId={purchaseId}
          item={item}
        />
      ))}
    </Stack>
  );
}
