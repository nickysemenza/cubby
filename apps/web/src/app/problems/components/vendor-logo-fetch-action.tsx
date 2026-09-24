import type { VendorOut } from "@cubby/schemas/vendor";
import { ImageIcon as ImageDown } from "@phosphor-icons/react/dist/csr/Image";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { vendor as vendorOperations } from "~/app/vendors/vendor.functions";
import { Button } from "~/components/ui/button";

type VendorLogoTarget = Pick<VendorOut, "id" | "name" | "website">;
type FetchLogoMutationOptions =
  typeof vendorOperations.fetchLogo.mutationOptions;

export interface VendorLogoFetchOperations {
  fetchLogo: FetchLogoMutationOptions;
}

const productionOperations: VendorLogoFetchOperations = {
  fetchLogo: vendorOperations.fetchLogo.mutationOptions,
};

/** Explicit per-item replacement for the retired vendor-logo seeder. */
export function VendorLogoFetchAction({
  vendor,
  operations = productionOperations,
}: {
  vendor: VendorLogoTarget;
  operations?: VendorLogoFetchOperations;
}) {
  const fetchLogo = useActionMutation({
    mutationFn: operations.fetchLogo,
    success: `Added logo for ${vendor.name}`,
  });

  // A website is a reviewed identity claim. Never guess one from the name just
  // to make the action available; opening the vendor is the path to add it.
  if (!vendor.website) return null;

  return (
    <Button
      size="sm"
      onClick={() => fetchLogo.mutate({ id: vendor.id })}
      disabled={fetchLogo.isPending}
    >
      <ImageDown className="mr-1 size-3" />
      {fetchLogo.isPending ? "Fetching…" : "Fetch logo"}
    </Button>
  );
}
