import { getDomain } from "tldts";

export type VendorMailIdentity = {
  website: string | null;
  orderEmailSenders: readonly string[];
};

const vendorWebsiteDomain = (website: string | null): string | null => {
  if (!website) return null;
  try {
    const url = new URL(website);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return getDomain(url.hostname, { allowPrivateDomains: true });
  } catch {
    return null;
  }
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
