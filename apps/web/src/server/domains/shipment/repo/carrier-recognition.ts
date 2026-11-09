import type { EmailTrackingKeys } from "@cubby/schemas/email-fields";

type Carrier = EmailTrackingKeys[number]["carrier"];

export const normalizeTrackingNumber = (value: string) =>
  value.replaceAll(/\s/gu, "").toUpperCase();

const UPS_NUMBER = /^1Z[0-9A-Z]{16}$/u;
// USPS IMpb: 20–22 or 26 digits from 91–95, optionally behind a 420+ZIP prefix.
export const USPS_NUMBER =
  /^(?:420\d{5}(?:\d{4})?)?(9[1-5](?:\d{18,20}|\d{24}))$/u;
const USPS_INTERNATIONAL = /^[A-Z]{2}\d{9}US$/u;
// OnTrac prints C or D followed by 14 digits.
const ONTRAC_NUMBER = /^[CD]\d{14}$/u;
export const TRACKING_PARAMS = new Set([
  "trknbr",
  "tracknum",
  "tracknums",
  "tracking_number",
  "trackingnumber",
  "tracknumbers",
  "tlabels",
]);

export function carrierFromHost(href: string): Carrier {
  try {
    const host = new URL(href).hostname.toLowerCase();
    if (/(?:^|\.)ups\.com$/u.test(host)) return "UPS";
    if (/(?:^|\.)fedex\.com$/u.test(host)) return "FedEx";
    if (/(?:^|\.)usps\.(?:com|gov)$/u.test(host)) return "USPS";
    if (/(?:^|\.)ontrac\.com$/u.test(host)) return "OnTrac";
  } catch {
    // SILENT: an unparseable link names no carrier.
  }
  return null;
}

/** A carrier the number's own format proves, else null. */
export function carrierFromNumber(number: string): Carrier {
  if (UPS_NUMBER.test(number)) return "UPS";
  if (USPS_NUMBER.test(number) || USPS_INTERNATIONAL.test(number))
    return "USPS";
  if (ONTRAC_NUMBER.test(number)) return "OnTrac";
  return null;
}

const amazonLink = (href: string) => {
  const url = URL.canParse(href) ? new URL(href) : null;
  return url?.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    /^(?:www\.)?amazon\.com$/.test(url.hostname)
    ? url
    : null;
};

/** The one bounded vendor route known to name a parcel: Amazon's package tracker
 * identifies it by order, shipment and package index, directly or through its own
 * redirect. An Amazon shipment can span parcels, so the index is required.
 */
export function vendorPackageLink(href: string) {
  const link = amazonLink(href);
  const redirect =
    link?.pathname === "/gp/r.html" ? link.searchParams.getAll("U") : [];
  const url = redirect[0] && !redirect[1] ? amazonLink(redirect[0]) : link;
  if (!url || !/^\/progress-tracker\/package(?:\/|$)/.test(url.pathname))
    return null;
  const [order, shipmentId, index] = [
    "orderId",
    "shipmentId",
    "packageIndex",
  ].map((name) => {
    const values = url.searchParams.getAll(name);
    return values.length === 1 ? values[0] : undefined;
  });
  return order && shipmentId && index && /^\d+$/.test(index)
    ? { order, shipmentId, index }
    : null;
}
