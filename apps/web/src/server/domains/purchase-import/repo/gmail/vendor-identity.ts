import { vendorWebsiteDomain } from "~/lib/vendor-domains";

export type VendorMailIdentity = {
  website: string | null;
  orderEmailSenders: readonly string[];
};

export const vendorSearchTerms = (vendor: VendorMailIdentity): string[] => {
  const domain = vendorWebsiteDomain(vendor.website);
  return [
    ...new Set(
      [domain, ...vendor.orderEmailSenders]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase()),
    ),
  ].sort();
};
