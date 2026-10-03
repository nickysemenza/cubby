import type {
  BrowserBridgeRequest,
  BrowserBridgeResult,
} from "@cubby/schemas/purchase-import";

/** Synthetic order-history pages and a fake browser bridge for worklist tests. */
export const HOST = "shop.example.test";
export const orderUrl = (id: string) =>
  `https://${HOST}/orders/details?orderID=${id}`;

/** A fake bridge whose next result is the page the test hands it. */
export function fakeBroker() {
  let issued: BrowserBridgeRequest | undefined;
  let capture: BrowserBridgeResult["outcome"] | undefined;
  const broker = {
    enqueue: async (command: BrowserBridgeRequest) => {
      issued = command;
    },
    result: async (): Promise<BrowserBridgeResult | null> =>
      issued && capture
        ? {
            protocolVersion: 2,
            commandID: issued.id,
            operationID: issued.operationId,
            runID: issued.runID,
            completedAt: new Date().toISOString(),
            outcome: capture,
          }
        : null,
    cancel: async () => undefined,
    connected: async () => true,
    pendingCommands: async () => [],
    notifyRunCompleted: async () => undefined,
    requestAuthentication: async () => undefined,
  };
  return {
    namespace: { getByName: () => broker },
    respondWith(outcome: BrowserBridgeResult["outcome"]) {
      capture = outcome;
    },
  };
}

export const historyPage = (
  orders: ReadonlyArray<{ id: string; date: string }>,
  next: string | null,
): BrowserBridgeResult["outcome"] => ({
  status: "completed",
  capture: {
    sourceURL: `https://${HOST}/order-history`,
    title: "Your Orders",
    capturedAt: new Date().toISOString(),
    captureVersion: 1,
    variantMarkers: [],
    readableText: orders
      .map(
        (order) =>
          `Order placed ${order.date} Order # ${order.id} Total $12.00`,
      )
      .join("\n"),
    links: [
      ...orders.map((order) => ({
        id: `link-${order.id}`,
        url: orderUrl(order.id),
        label: "View order details",
      })),
      ...(next ? [{ id: "next", url: next, label: "Next →" }] : []),
    ],
    images: [],
    paymentEvidence: [],
    evidence: [],
  },
});
