import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useProductLookupInvalidation } from "~/app/_components/inventory/hooks/useInventoryMutation";
import { product } from "~/app/products/product.functions";
import { ScanWorkbench } from "~/app/scan/ScanWorkbench";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";
import { toastMutationWarnings } from "~/lib/recompute-summary";
import type { ResolvedScanCode } from "~/lib/scan-code";

export const Route = createFileRoute("/_authenticated/scan")({
  component: ScanPage,
  head: () => ({ meta: [{ title: pageTitle("Scan") }] }),
});

function ScanPage() {
  const navigate = useNavigate();
  const invalidateProductLookup = useProductLookupInvalidation();
  const findOrCreate = useMutation(
    product.findOrCreateByCode.mutationOptions({
      onSuccess: invalidateProductLookup,
    }),
  );

  const resolve = useCallback(
    async (value: ResolvedScanCode) => {
      if (value.kind === "shortcode") {
        await navigate({
          to: "/$shortcode",
          params: { shortcode: value.shortcode },
        });
        return;
      }

      const result = await findOrCreate.mutateAsync(value.code);
      toastMutationWarnings(result.sideEffects);
      await navigate({
        to: "/products/$shortcode",
        params: { shortcode: result.product.id },
      });
    },
    [findOrCreate, navigate],
  );

  return (
    <Page variant="list" title="Scan" compact decoration="none">
      <ScanWorkbench onResolve={resolve} />
    </Page>
  );
}
