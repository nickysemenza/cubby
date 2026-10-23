import type { ImageUrlSummary } from "@cubby/schemas/image-summary";

import { useEntityDisplayImage } from "~/entity/entity-media/entity-display-images";

import { EntityIdentityMark } from "./entity-identity-mark";
import { EntityRefLink } from "./entity-ref-link";

/** Standalone vendor marks use the same canonical identity as record pills. */
export function VendorMark({
  vendor,
  vendorId,
  logo,
  className,
}: {
  vendor: string;
  vendorId?: string | null;
  logo?: ImageUrlSummary | null;
  className?: string;
}) {
  const image = useEntityDisplayImage({
    entityKind: "vendor",
    entityId: vendorId ?? "",
  });
  return (
    <EntityIdentityMark
      entity="vendor"
      id={vendorId ?? undefined}
      name={vendor}
      displayImage={logo ?? image}
      className={className}
    />
  );
}

/** Unresolved vendor text stays readable until its canonical reference arrives. */
export function VendorCell({
  vendor,
  vendorId,
  logo,
}: {
  vendor: string;
  vendorId?: string | null;
  logo?: ImageUrlSummary | null;
}) {
  if (!vendorId) return <span>{vendor}</span>;
  return (
    <EntityRefLink
      entity="vendor"
      id={vendorId}
      name={vendor}
      displayImage={logo ?? undefined}
    />
  );
}
