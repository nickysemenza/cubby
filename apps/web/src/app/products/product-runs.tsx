import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleDashedIcon } from "@phosphor-icons/react/dist/csr/CircleDashed";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import { Stack } from "~/components/layout";
import { StatusText } from "~/components/ui/status-text";
import type { RunSummary } from "~/contracts/run.contract";
import { entityListFor } from "~/entities/entity-list.functions";
import { run as runOperations } from "~/entities/run.functions";
import { purchaseLabel } from "~/lib/purchase-label";

import { runHref } from "../purchases/purchase-import-links";
import { TargetedImportLaunchButton } from "../purchases/targeted-import-launch";

function JourneyStep({
  label,
  detail,
  complete,
}: {
  label: string;
  detail: string;
  complete: boolean;
}) {
  const Icon = complete ? CheckCircleIcon : CircleDashedIcon;
  return (
    <div className="flex min-w-0 items-start gap-2 border border-border bg-background p-2.5">
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${complete ? "text-positive" : "text-muted-foreground"}`}
      />
      <div className="min-w-0">
        <span className="block text-xs font-semibold">{label}</span>
        <span className="block text-xs break-words text-muted-foreground">
          {detail}
        </span>
      </div>
    </div>
  );
}

/** Targeted enrichment history stays visible even when a run made no writes. */
export const ProductRuns: DetailSlotComponent<"product"> = ({
  record: product,
}) => {
  const runs = useQuery({
    ...runOperations.history.queryOptions({ productId: product.id }),
    select: (history) => history.runs,
  });
  const purchases = useQuery(
    entityListFor("purchase").queryOptions({
      filters: { productId: parseShortcodeFor("product", product.id) },
      pagination: { pageIndex: 0, pageSize: 20 },
    }),
  );
  const launch = (
    <TargetedImportLaunchButton
      targetId={product.id}
      targetLabel={product.name}
      purpose="product_enrichment"
    />
  );
  const ownPhotos = product.attachments.filter(
    (image) => image.source === "own",
  ).length;
  const linkedPurchases = purchases.data?.items ?? [];
  const settled = linkedPurchases.some(
    (purchase) => purchase.financialReconciliation.status === "match",
  );
  return (
    <Stack gap="sm">
      <div className="rounded-md border border-border bg-card p-3 text-sm">
        <strong className="block">Finish this item</strong>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Keep photos, stock, purchase and statement evidence together.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <JourneyStep
            label="Your photos"
            detail={ownPhotos ? `${ownPhotos} own photos` : "Add an item photo"}
            complete={ownPhotos > 0}
          />
          <JourneyStep
            label="Inventory"
            detail={
              product.inventoryEntry.length
                ? "Inventory recorded"
                : "Record where it lives"
            }
            complete={product.inventoryEntry.length > 0}
          />
          <JourneyStep
            label="Purchase & statement"
            detail={
              purchases.isPending
                ? "Checking purchases"
                : linkedPurchases.length
                  ? settled
                    ? "Statement matched"
                    : "Review statement match"
                  : "Match a purchase"
            }
            complete={settled}
          />
        </div>
        {purchases.isError ? (
          <StatusText tone="destructive">{purchases.error.message}</StatusText>
        ) : null}
        {linkedPurchases.map((purchase) => (
          <div
            key={purchase.id}
            className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1"
          >
            <Link
              to="/purchases/$shortcode"
              params={{ shortcode: purchase.id }}
              className="font-medium text-primary hover:underline"
            >
              {purchaseLabel(purchase)}
            </Link>
            <span className="text-muted-foreground">
              {purchase.financialReconciliation.status === "match"
                ? "Statement matched"
                : "Statement match still needed"}
            </span>
          </div>
        ))}
      </div>
      {launch}
      <p className="text-sm text-muted-foreground">
        To match this item to a purchase, open the purchase and choose
        <strong className="font-medium text-foreground">
          {" "}
          Attach products
        </strong>
        . Retailer and Gmail imports can also match an existing Product when an
        order is processed.
      </p>
      <Link
        to="/purchases"
        className="w-fit text-sm font-medium text-primary hover:underline"
      >
        Find a purchase
      </Link>
      {runs.isPending ? (
        <StatusText>Loading enrichment history…</StatusText>
      ) : null}
      {runs.isError ? (
        <StatusText tone="destructive">{runs.error.message}</StatusText>
      ) : null}
      {runs.isSuccess ? (
        runs.data.length ? (
          <div className="grid gap-3">
            {runs.data.map((run) => (
              <ProductRunSummary key={run.publicId} run={run} />
            ))}
          </div>
        ) : (
          <StatusText>
            No targeted enrichment runs have been recorded.
          </StatusText>
        )
      ) : null}
    </Stack>
  );
};

function ProductRunSummary({ run }: { run: RunSummary }) {
  return (
    <div className="grid gap-1 border-b border-border pb-3 text-sm last:border-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-medium">
          {run.vendorName ?? run.vendorAccountLabel ?? "Product enrichment"}
        </span>
        <span className="text-muted-foreground">
          {run.purpose?.replaceAll("_", " ") ?? "product enrichment"} ·{" "}
          {run.status}
        </span>
      </div>
      <span className="text-muted-foreground">
        {new Date(run.startedAt).toLocaleString()} · {run.trigger}
      </span>
      {run.failureCode ? (
        <span className="text-destructive">{run.failureCode}</span>
      ) : null}
      <a
        className="w-fit text-xs font-medium text-primary hover:underline"
        href={runHref(run.publicId)}
      >
        Open import run
      </a>
    </div>
  );
}
