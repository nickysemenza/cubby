import type { ProductPurchaseOut } from "@cubby/schemas/purchase";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
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
import { parsePlainDate } from "~/lib/plain-date";
import { purchaseLabel } from "~/lib/purchase-label";
import { purchaseProductMutationInvalidateKeys } from "~/lib/query-keys";

const EMPTY_PURCHASES: ProductPurchaseOut[] = [];

function purchaseSubtitle(item: ProductPurchaseOut): string | null {
  const parts = [
    item.vendorName,
    format(parsePlainDate(item.date), "MMM d, yyyy"),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function ProductPurchaseRow({
  productId,
  item,
}: {
  productId: string;
  item: ProductPurchaseOut;
}) {
  const api = useTRPC();
  const label = purchaseLabel(item);
  const detach = useActionMutation({
    mutationFn: api.purchase.detachProducts.mutationOptions,
    success: `Removed from ${label}`,
    invalidateKeys: purchaseProductMutationInvalidateKeys,
  });
  const subtitle = purchaseSubtitle(item);

  return (
    <Row
      align="center"
      justify="between"
      gap="md"
      className="border border-[var(--border)] p-4"
    >
      <Stack gap="xs" className="min-w-0">
        <EntityInlineLink
          entity="purchase"
          data={{
            id: item.purchaseId,
            orderId: item.orderId,
            displayLabel: item.displayLabel,
            vendorName: item.vendorName,
            date: item.date,
          }}
          truncate
        />
        {subtitle && <Description size="xs">{subtitle}</Description>}
      </Stack>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${label}`}
        disabled={detach.isPending}
        onClick={() =>
          detach.mutate({
            purchaseId: item.purchaseId,
            productIds: [productId],
          })
        }
      >
        <Trash2 />
      </Button>
    </Row>
  );
}

/**
 * The Purchases one Product is linked to — the transpose of
 * `PurchaseProductsTable`. This is how a product-first read answers "which
 * order(s) did this come from," including lump-sum/installment orders whose
 * Expenses can't carry a `productId` at all (see
 * `packages/schemas/src/purchase.ts`). No money or quantity lives here.
 */
export function ProductPurchases({ productId }: { productId: string }) {
  const api = useTRPC();
  const query = useQuery(api.product.purchases.queryOptions({ productId }));
  const items = query.data ?? EMPTY_PURCHASES;

  if (query.isPending) {
    return <Description>Loading purchases…</Description>;
  }

  if (items.length === 0) {
    return (
      <Empty variant="minimal" className="py-6">
        <EmptyHeader>
          <EmptyTitle>No purchases linked</EmptyTitle>
          <EmptyDescription>
            Attach this product from a purchase&apos;s Products section to
            record which order it came from.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Stack gap="xs">
      {items.map((item) => (
        <ProductPurchaseRow
          key={item.purchaseId}
          productId={productId}
          item={item}
        />
      ))}
    </Stack>
  );
}
