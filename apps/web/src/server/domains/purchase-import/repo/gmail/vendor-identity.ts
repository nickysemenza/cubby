import {
  broadcastSender,
  SHARED_SENDER_DOMAINS,
  vendorWebsiteDomain,
} from "~/lib/vendor/domains";

export type VendorMailIdentity = {
  website: string | null;
  orderEmailSenders: readonly string[];
};

export const vendorSearchTerms = (vendor: VendorMailIdentity): string[] => {
  const domain = vendorWebsiteDomain(vendor.website);
  return [
    ...new Set(
      [
        domain && !SHARED_SENDER_DOMAINS.has(domain) ? domain : null,
        ...vendor.orderEmailSenders.filter(
          (address) => !broadcastSender(address),
        ),
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase()),
    ),
  ].sort();
};
