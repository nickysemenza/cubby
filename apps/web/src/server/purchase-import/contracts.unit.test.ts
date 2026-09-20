import { describe, expect, it } from "vitest";

import { decodeBrowserBridgeMessage } from "./contracts";

const hello = {
  protocolVersion: 2,
  type: "hello",
  deviceID: "11111111-1111-4111-8111-111111111111",
  browser: "chrome",
  capabilities: {
    fixedCaptureVersion: 1,
    enhancedScreenshot: true,
    renderedPDF: true,
  },
};

describe("decodeBrowserBridgeMessage", () => {
  it.each([
    ["text", JSON.stringify(hello)],
    ["binary", new TextEncoder().encode(JSON.stringify(hello)).buffer],
  ])("accepts the Mac bridge's %s WebSocket frame", (_kind, frame) => {
    expect(decodeBrowserBridgeMessage(frame).data).toEqual(hello);
  });

  it("rejects malformed frames without throwing", () => {
    expect(
      decodeBrowserBridgeMessage(new TextEncoder().encode("{").buffer).success,
    ).toBe(false);
  });

  it("rejects the replaced protocol generation", () => {
    expect(
      decodeBrowserBridgeMessage(
        JSON.stringify({ ...hello, protocolVersion: 1 }),
      ).success,
    ).toBe(false);
  });

  it("accepts optional capture fields omitted by Swift Codable", () => {
    const result = {
      protocolVersion: 2,
      type: "result",
      result: {
        protocolVersion: 2,
        commandID: "22222222-2222-4222-8222-222222222222",
        operationID: "browser-command:capture-001",
        runID: "33333333-3333-4333-8333-333333333333",
        completedAt: "2026-09-20T15:00:00Z",
        outcome: {
          status: "completed",
          capture: {
            sourceURL: "https://example.com/orders",
            title: "Orders",
            capturedAt: "2026-09-20T15:00:00Z",
            captureVersion: 1,
            readableText: "Order history",
            links: [{ id: "link-1", url: "https://example.com/orders/1" }],
            images: [{ url: "https://example.com/order.png" }],
            paymentEvidence: [{}],
            evidence: [],
          },
        },
      },
    };

    expect(decodeBrowserBridgeMessage(JSON.stringify(result)).success).toBe(
      true,
    );
  });
});
