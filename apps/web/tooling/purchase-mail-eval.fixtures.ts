// Synthetic source transport only. No proposed order or assessor answer enters
// the real researcher; the fixed expectations remain in the acceptance runner.
export const mailEvalOrderId = "SYNTHETIC-LIVE-410";
export const mailEvalMailboxId = "synthetic-live-mailbox";
export const mailEvalPage = {
  url: "https://maker.example.test/portable-fan?size=small&color=blue",
  title: "Example Works portable fan — small, blue",
  description: "Manufacturer specifications for the selected small blue fan.",
  html: `<html><head><title>Portable fan — small, blue</title></head><body><h1>Example Works portable fan</h1><select aria-label="Size"><option selected>Small</option><option>Large</option></select><select aria-label="Color"><option selected>Blue</option><option>Red</option></select><p>Selected variant: small, blue. Manufacturer: Example Works. Model P-20-SB. Retailer SKU FAN-SM-BL.</p><p>The large red variant has model P-20-LR and SKU FAN-LG-RD. Those identifiers do not apply to the selected small blue fan.</p><p>No representative image is available on this page.</p></body></html>`,
};

const order = `Order ${mailEvalOrderId}. Merchant: Example Works (https://maker.example.test). Ordered 2026-09-14. Item: Example Works portable fan, small, blue. Quantity 1. Item amount USD 24.00. Printed total USD 24.00. Product specifications: ${mailEvalPage.url}.`;
export const mailEvalOriginals = [
  {
    id: "synthetic-live-confirmation",
    subject: `Order confirmation ${mailEvalOrderId}`,
    receivedAt: "2026-09-14T12:00:00Z",
    content: `${order} This is the order confirmation. The item has not shipped yet.`,
  },
  {
    id: "synthetic-live-shipment",
    subject: `Shipment for ${mailEvalOrderId}`,
    receivedAt: "2026-09-15T12:00:00Z",
    content: `${order} Your order has shipped. Tracking reference SYNTHETIC-TRACK-410.`,
  },
] as const;

export const mailEvalMessages = mailEvalOriginals.map((original) => ({
  id: original.id,
  threadId: "synthetic-live-order-thread",
  historyId: "100",
  labelIds: [],
  internalDate: String(Date.parse(original.receivedAt)),
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "orders@maker.example.test" },
      { name: "Subject", value: original.subject },
    ],
    body: {
      data: btoa(original.content)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, ""),
      size: new TextEncoder().encode(original.content).byteLength,
    },
  },
}));
