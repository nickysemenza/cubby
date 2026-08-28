import type { VendorOut } from "@cubby/schemas/vendor";
import { ImageDown } from "lucide-react";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { vendor as vendorOperations } from "~/app/vendors/vendor.functions";
import { Button } from "~/components/ui/button";

type VendorLogoTarget = Pick<VendorOut, "id" | "name" | "website">;

/** Explicit per-item replacement for the retired vendor-logo seeder. */
export function VendorLogoFetchAction({
  vendor,
}: {
  vendor: VendorLogoTarget;
}) {
  const fetchLogo = useActionMutation({
    mutationFn: vendorOperations.fetchLogo.mutationOptions,
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
