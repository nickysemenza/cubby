import { ExternalLinkIcon } from "~/app/_components/ExternalLink";

/**
 * The link out to a vendor's own order page for a purchase's order id.
 *
 * `orderUrl` is derived server-side from the vendor's `orderUrlTemplate`
 * (`purchaseOrderUrl`), so null here means one of: the vendor has no template,
 * the purchase has no order id, or the id is a synthetic import key like
 * `txn:2023-09-17/639/5201` that no template can resolve. All three render as
 * nothing rather than as a dead link.
 *
 * Deliberately an icon *beside* the id rather than a link *on* it: every
 * surface that shows an order id either edits it inline or sits in a clickable
 * table row, and both of those own the click on the text itself.
 */
export function OrderIdLink({
  orderUrl,
  orderId,
  vendorName,
}: {
  orderUrl: string | null | undefined;
  orderId: string | null | undefined;
  vendorName?: string | null;
}) {
  if (!orderUrl) return null;
  return (
    <ExternalLinkIcon
      href={orderUrl}
      label={`Open order ${orderId ?? ""} at ${vendorName ?? "the vendor"}`.trim()}
    />
  );
}
