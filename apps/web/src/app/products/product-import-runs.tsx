import { useQuery } from "@tanstack/react-query";

import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import { Stack } from "~/components/layout";
import { StatusText } from "~/components/ui/status-text";
import {
  purchaseImportRunsError,
  purchaseImportRunsResponse,
  type PurchaseImportRunSummary,
} from "~/lib/purchase-import-run-detail";

import { purchaseImportRunHref } from "../purchases/purchase-import-links";
import { TargetedImportLaunchButton } from "../purchases/targeted-import-launch";

/** Targeted enrichment history stays visible even when a run made no writes. */
export const ProductImportRuns: DetailSlotComponent<"product"> = ({
  record: product,
}) => {
  const runs = useQuery({
    queryKey: ["purchase-import", "product-runs", product.id],
    queryFn: async () => {
      const response = await fetch(
        `/api/import/runs?productId=${encodeURIComponent(product.id)}`,
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        const parsed = purchaseImportRunsError.safeParse(body);
        throw new Error(
          parsed.success
            ? parsed.data.error
            : "Product enrichment runs could not load.",
        );
      }
      return purchaseImportRunsResponse.parse(body).runs;
    },
  });
  const launch = (
    <TargetedImportLaunchButton
      targetId={product.id}
      targetLabel={product.name}
      purpose="product_enrichment"
    />
  );
  if (runs.isPending)
    return (
      <Stack gap="sm">
        {launch}
        <StatusText>Loading enrichment history…</StatusText>
      </Stack>
    );
  if (runs.isError)
    return (
      <Stack gap="sm">
        {launch}
        <StatusText tone="destructive">{runs.error.message}</StatusText>
      </Stack>
    );
  return (
    <Stack gap="sm">
      {launch}
      {runs.data?.length ? (
        <div className="grid gap-3">
          {runs.data.map((run) => (
            <ProductImportRunSummary key={run.publicId} run={run} />
          ))}
        </div>
      ) : (
        <StatusText>No targeted enrichment runs have been recorded.</StatusText>
      )}
    </Stack>
  );
};

function ProductImportRunSummary({ run }: { run: PurchaseImportRunSummary }) {
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
        href={purchaseImportRunHref(run.publicId)}
      >
        Open import run
      </a>
    </div>
  );
}
