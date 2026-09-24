import type {
  CollectionProductPlacementOut,
  CollectionProductPurchaseOut,
} from "@cubby/schemas/collection";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { ClipboardIcon } from "@phosphor-icons/react/dist/csr/Clipboard";
import { MapPinIcon } from "@phosphor-icons/react/dist/csr/MapPin";
import { ReceiptIcon } from "@phosphor-icons/react/dist/csr/Receipt";
import { Link } from "@tanstack/react-router";
import { format } from "date-fns";
import { useEffect, useState } from "react";

import { TradeBadge } from "~/app/projects/trade-options";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { copyShortcodes } from "~/lib/clipboard";
import { parsePlainDate } from "~/lib/plain-date";
import { purchaseLabel, purchaseLabelUsedVendor } from "~/lib/purchase-label";
import { cn } from "~/lib/utils";

export function CopyableShortcode({
  code,
  className,
}: {
  code: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      aria-label={`Copy shortcode ${code}`}
      title={copied ? "Copied" : `Copy ${code}`}
      onClick={async () => {
        if (await copyShortcodes([code])) setCopied(true);
      }}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 border border-border px-1 font-mono text-2xs text-muted-foreground tabular-nums transition-colors hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
    >
      {code}
      {copied ? (
        <CheckIcon className="size-3" aria-hidden />
      ) : (
        <ClipboardIcon className="size-3" aria-hidden />
      )}
    </button>
  );
}

export function ProductPlacementsPopover({
  placements,
}: {
  placements: CollectionProductPlacementOut[];
}) {
  if (placements.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
        <MapPinIcon className="size-3" aria-hidden /> Unplaced
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        closeDelay={150}
        className="inline-flex h-5 items-center gap-1 text-2xs text-muted-foreground underline decoration-border decoration-dotted underline-offset-2 hover:text-primary hover:decoration-primary focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={`Show ${placements.length} current ${placements.length === 1 ? "location" : "locations"}`}
      >
        <MapPinIcon className="size-3" aria-hidden />
        {placements.length} {placements.length === 1 ? "location" : "locations"}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-80 p-0">
        <PopoverHeader className="border-b border-border p-2">
          <PopoverTitle>Current locations</PopoverTitle>
        </PopoverHeader>
        <div className="max-h-72 overflow-y-auto">
          {placements.map((placement) => (
            <Link
              key={placement.id}
              to="/locations/$shortcode"
              params={{ shortcode: placement.id }}
              className="block border-b border-border p-2 transition-colors last:border-b-0 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="block text-xs font-medium">
                {placement.name}
              </span>
              <span className="mt-1 block text-2xs text-muted-foreground">
                {placement.path.join(" / ")}
              </span>
            </Link>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ProductPurchasesPopover({
  purchases,
}: {
  purchases: CollectionProductPurchaseOut[];
}) {
  if (purchases.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
        <ReceiptIcon className="size-3" aria-hidden /> No purchase
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        closeDelay={150}
        className="inline-flex h-5 items-center gap-1 text-2xs text-muted-foreground underline decoration-border decoration-dotted underline-offset-2 hover:text-primary hover:decoration-primary focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={`Show ${purchases.length} linked ${purchases.length === 1 ? "purchase" : "purchases"}`}
      >
        <ReceiptIcon className="size-3" aria-hidden />
        {purchases.length} {purchases.length === 1 ? "purchase" : "purchases"}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-80 p-0">
        <PopoverHeader className="border-b border-border p-2">
          <PopoverTitle>Purchase history</PopoverTitle>
        </PopoverHeader>
        <div className="max-h-80 overflow-y-auto">
          {purchases.map((purchase) => (
            <div
              key={purchase.id}
              className="border-b border-border p-2 last:border-b-0"
            >
              <Link
                to="/purchases/$shortcode"
                params={{ shortcode: purchase.id }}
                className="text-xs font-medium hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {purchaseLabel(purchase)}
              </Link>
              <p className="mt-1 text-2xs text-muted-foreground">
                {!purchaseLabelUsedVendor(purchase) && purchase.vendorName
                  ? `${purchase.vendorName} · `
                  : ""}
                <time dateTime={purchase.date}>
                  {format(parsePlainDate(purchase.date), "MMM d, yyyy")}
                </time>
              </p>
              {purchase.trades.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {purchase.trades.map((trade) => (
                    <TradeBadge key={trade} trade={trade} />
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-2xs text-muted-foreground">
                  Trade not recorded
                </p>
              )}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ProductTradeBadges({
  purchases,
  className,
}: {
  purchases: CollectionProductPurchaseOut[];
  className?: string;
}) {
  const trades = [...new Set(purchases.flatMap((purchase) => purchase.trades))];
  if (trades.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {trades.map((trade) => (
        <TradeBadge key={trade} trade={trade} />
      ))}
    </div>
  );
}

export function ProductContextLine({
  shortcode,
  placements,
  purchases,
  className,
}: {
  shortcode: string;
  placements: CollectionProductPlacementOut[];
  purchases: CollectionProductPurchaseOut[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1",
        className,
      )}
    >
      <CopyableShortcode code={shortcode} />
      <ProductPlacementsPopover placements={placements} />
      <ProductPurchasesPopover purchases={purchases} />
      <ProductTradeBadges purchases={purchases} />
    </div>
  );
}
