import type { VendorOut } from "@cubby/schemas/vendor";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";

import {
  missingLogoWebsiteReason,
  productionLogoOperations,
  useFetchVendorLogo,
  type VendorLogoFetchOperations,
} from "~/entity/actions/vendor-logo-entity-action";
export type { VendorLogoFetchOperations } from "~/entity/actions/vendor-logo-entity-action";
import { Link } from "@tanstack/react-router";

import { Button } from "~/ui/primitives/button";

type VendorLogoTarget = Pick<VendorOut, "id" | "name" | "website">;
/** Explicit per-item replacement for the retired vendor-logo seeder. */
export function VendorLogoFetchAction({
  vendor,
  operations = productionLogoOperations,
}: {
  vendor: VendorLogoTarget;
  operations?: VendorLogoFetchOperations;
}) {
  const fetchLogo = useFetchVendorLogo(operations);
  const pending = fetchLogo.isPending(vendor.id);
  const reason = !vendor.website ? missingLogoWebsiteReason : undefined;
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        size="sm"
        onClick={() => {
          void fetchLogo.fetch(vendor.id).catch(() => {
            // SILENT: useFetchVendorLogo already displays the raw mutation error.
          });
        }}
        disabled={pending || Boolean(reason)}
      >
        <ImageIcon className="mr-1 size-3" />
        {pending ? "Fetching…" : "Fetch logo"}
      </Button>
      {reason && (
        <p className="text-xs text-muted-foreground">
          {reason}{" "}
          <Link
            className="text-link hover:underline"
            to="/vendors/$shortcode"
            params={{ shortcode: vendor.id }}
          >
            Open vendor
          </Link>
        </p>
      )}
    </div>
  );
}
