import { MapPinIcon } from "@phosphor-icons/react/dist/csr/MapPin";
import { QuestionIcon } from "@phosphor-icons/react/dist/csr/Question";
import { SkipForwardIcon } from "@phosphor-icons/react/dist/csr/SkipForward";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { ProductBulkAddToInventoryDialog } from "~/features/products/product-bulk-add-to-inventory-dialog";
import { ProductDiscardDialog } from "~/features/products/product-discard-dialog";
import { defaultStockAmount } from "~/features/products/product-hero-presence";
import { QueuePassPosition } from "~/features/queue-pass/QueuePassProgress";
import { inventory } from "~/integrations/tanstack-query/generated/inventory.gen";
import { location } from "~/integrations/tanstack-query/generated/location.gen";
import { formatCurrency } from "~/lib/utils";
import { showErrorToast } from "~/ui/feedback/error-details";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Card, CardContent } from "~/ui/primitives/card";
import { Description } from "~/ui/primitives/description";
import { Image } from "~/ui/primitives/image";

import type { TriageProduct } from "./triage-types";

/**
 * One product, exactly three ways out: discard it, stock it at a location, or
 * park it in the household Unknown. Skipping only defers.
 *
 * Nothing here receives or decrements anything on its own — every choice is an
 * explicit write the operator just made, and the proposed amount is a default
 * in a field they can change (Park is the one path with no field, so it writes
 * the same proposal and the entry remains a normal shelf row to recount).
 */
export function TriageStopCard({
  product,
  index,
  total,
  onSettled,
  onSkip,
}: {
  product: TriageProduct;
  index: number;
  total: number;
  /** Called once a choice has been written — the pass moves on. */
  onSettled: () => void;
  onSkip: () => void;
}) {
  const [stockOpen, setStockOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  const expected = product.quantityLedger.expectedQuantity;
  const proposed = defaultStockAmount({
    expectedQuantity: expected,
    onHandUnits: product.onHandUnits,
  });

  const ensureUnknown = useMutation(
    location.ensureGlobalUnknown.mutationOptions({
      onError: (error) => showErrorToast(error, "Could not create Unknown"),
    }),
  );
  const park = useActionMutation({
    mutationFn: inventory.bulkAdd.mutationOptions,
    success: () => `Parked ${product.name} in Unknown.`,
    onSuccess: onSettled,
  });

  const parkInUnknown = async () => {
    // Idempotent: returns the existing Unknown when there is one, so the pass
    // never creates a second and never depends on it having been resolved
    // before this click.
    const unknown = await ensureUnknown
      .mutateAsync(undefined)
      .catch(() => null);
    // SILENT: ensureUnknown's onError already showErrorToast'd this failure.
    if (!unknown) return;
    park.mutate({
      locationId: unknown.id,
      items: [{ productId: product.id, amount: proposed }],
    });
  };

  const busy = ensureUnknown.isPending || park.isPending;
  const cover = product.displayImages[0]?.url;

  return (
    <Card>
      <CardContent className="p-4">
        <Stack gap="md">
          <Row align="start" gap="md" className="min-w-0">
            <Image
              src={cover}
              alt={product.name}
              displayWidth={96}
              className="size-24 shrink-0 border border-[var(--border)] object-cover"
            />
            <Stack gap="xs" className="min-w-0 flex-1">
              <QueuePassPosition
                index={index}
                total={total}
                className="text-left"
              />
              <h2 className="min-w-0 font-heading text-xl font-semibold">
                <EntityRefLink
                  displayImage={null}
                  showIdentityMark={false}
                  entity="product"
                  data={product}
                />
              </h2>
              {product.manufacturer && (
                <Description size="xs">{product.manufacturer}</Description>
              )}
              <Description>
                The ledger says {expected} bought
                {product.expenseTotal > 0
                  ? ` for ${formatCurrency(product.expenseTotal)}`
                  : ""}
                . Nothing is on a shelf.
              </Description>
            </Stack>
          </Row>

          <Row gap="sm" wrap>
            <Button
              type="button"
              className="min-h-12 md:min-h-10"
              disabled={busy}
              onClick={() => setStockOpen(true)}
            >
              <MapPinIcon />
              Stock at a location
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-12 md:min-h-10"
              disabled={busy}
              onClick={() => void parkInUnknown()}
            >
              <QuestionIcon />
              Park in Unknown
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-12 md:min-h-10"
              disabled={busy}
              onClick={() => setDiscardOpen(true)}
            >
              <TrashIcon />
              Discard
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-12 md:min-h-10"
              disabled={busy}
              onClick={onSkip}
            >
              <SkipForwardIcon />
              Skip for now
            </Button>
          </Row>
          <Description size="xs">
            Parked items show up under Items parked in Unknown, ready to move
            once you find where they live.
          </Description>
        </Stack>
      </CardContent>

      <ProductBulkAddToInventoryDialog
        key={`stock:${product.id}`}
        open={stockOpen}
        onOpenChange={setStockOpen}
        products={[
          {
            id: product.id,
            name: product.name,
            manufacturer: product.manufacturer,
            defaultAmount: proposed,
          },
        ]}
        onComplete={onSettled}
      />
      <ProductDiscardDialog
        key={`discard:${product.id}`}
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        product={product}
        defaultQuantity={expected > 0 ? expected : undefined}
        onComplete={onSettled}
      />
    </Card>
  );
}
