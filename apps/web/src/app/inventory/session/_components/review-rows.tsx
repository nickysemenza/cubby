import type { Amount } from "@cubby/schemas/codec";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import type { InfLocation } from "@cubby/schemas/location";
import type { ReactNode } from "react";

import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { Row } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { Image } from "~/components/ui/image";
import { cn } from "~/lib/utils";

import { AuditedHint } from "./AuditedHint";
import { LocationContentsPreview } from "./LocationContentsPreview";
import type { InventoryItem } from "./types";

// The compact card skeleton shared by the expected-contents list and the
// Unknown tray: a 48px thumbnail, an info column that fills the width, and a
// trailing controls slot. Border/state coloring comes from `className`; the
// caller owns the action buttons so each surface keeps its own affordances.

/** A child/parked location: photo or icon, name link, aggregate count, contents peek. */
export function LocationReviewCard({
  location,
  previewItems,
  className,
  badge,
  actions,
}: {
  location: InfLocation;
  previewItems: InventoryItem[];
  className?: string;
  badge?: ReactNode;
  actions: ReactNode;
}) {
  const itemCount = location.totalItemCount ?? 0;
  return (
    <div className={cn("border border-[var(--border)] p-2", className)}>
      <Row align="start" gap="sm" className="min-w-0">
        <div className="flex size-12 shrink-0 items-center justify-center border border-primary/30 bg-primary/10 text-primary">
          {location.images[0]?.url ? (
            <Image
              src={location.images[0].url}
              alt={location.name}
              displayWidth={48}
              className="h-full w-full object-cover"
            />
          ) : (
            <LocationIcon type={location.type} product={null} size={22} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <Row align="baseline" gap="xs" wrap className="min-w-0">
            <EntityInlineLink
              displayImage={null}
              showIdentityMark={false}
              entity="location"
              data={{
                id: location.id,
                name: location.name,
                type: location.type,
              }}
              truncate
            />
            {badge}
            <Description size="xs" className="shrink-0">
              {location.children?.length ?? 0} loc · {itemCount}{" "}
              {itemCount === 1 ? "item" : "items"}
            </Description>
          </Row>
          <LocationContentsPreview items={previewItems} />
        </div>
        <Row gap="xs" className="shrink-0">
          {actions}
        </Row>
      </Row>
    </div>
  );
}

/** A product line: thumbnail, name link, staged badges, amount, and a controls slot. */
export function ItemReviewCard({
  product,
  amount,
  badges,
  verifiedAt,
  className,
  controls,
}: {
  product: InventoryItem["product"];
  amount: Amount;
  badges?: ReactNode;
  verifiedAt?: InventoryItem["verifiedAt"];
  className?: string;
  controls: ReactNode;
}) {
  return (
    <div className={cn("border border-[var(--border)] p-2", className)}>
      <Row align="center" gap="sm" wrap className="min-w-0">
        <Row align="center" gap="sm" className="min-w-56 flex-1">
          <Image
            src={product.images.find(isDisplayableImageFile)?.url}
            alt={product.name}
            displayWidth={48}
            className="size-12 shrink-0 border border-[var(--border)] object-cover"
          />
          <div className="min-w-0 flex-1">
            <Row align="baseline" gap="xs" wrap className="min-w-0">
              <EntityInlineLink
                displayImage={null}
                showIdentityMark={false}
                entity="product"
                data={product}
                truncate
              />
              {badges}
              <Description size="xs" className="shrink-0">
                {tryFormatAmount(amount)}
              </Description>
              {verifiedAt && (
                <AuditedHint
                  at={verifiedAt}
                  label="verified"
                  className="shrink-0 text-2xs"
                />
              )}
            </Row>
          </div>
        </Row>
        <Row align="center" gap="sm" wrap className="shrink-0 justify-end">
          {controls}
        </Row>
      </Row>
    </div>
  );
}
