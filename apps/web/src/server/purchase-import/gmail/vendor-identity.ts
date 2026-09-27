import { getDomain } from "tldts";

export type VendorMailIdentity = {
  website: string | null;
  orderEmailSenders: readonly string[];
};

const senderAddress = (header: string): string | null => {
  const trimmed = header.trim();
  const bracketed = /<([^<>\s@]+@[^<>\s@]+)>$/u.exec(trimmed);
  const address = bracketed?.[1] ?? trimmed;
  return /^[^<>\s@]+@[^<>\s@]+$/u.test(address) ? address.toLowerCase() : null;
};

export const vendorWebsiteDomain = (website: string | null): string | null => {
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

export const matchesVendorSender = (
  header: string,
  vendor: VendorMailIdentity,
): boolean => {
  const address = senderAddress(header);
  if (!address) return false;
  if (matchesConfiguredVendorSender(header, vendor)) return true;
  const domain = vendorWebsiteDomain(vendor.website);
  return (
    domain !== null &&
    getDomain(address.slice(address.lastIndexOf("@") + 1), {
      allowPrivateDomains: true,
    }) === domain
  );
};

export const matchesConfiguredVendorSender = (
  header: string,
  vendor: VendorMailIdentity,
): boolean => {
  const address = senderAddress(header);
  return (
    address !== null &&
    vendor.orderEmailSenders.some(
      (sender) => sender.trim().toLowerCase() === address,
    )
  );
};
