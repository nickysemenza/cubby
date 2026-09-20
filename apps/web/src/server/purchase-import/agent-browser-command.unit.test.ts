import { describe, expect, it } from "vitest";

import { resolvePurchaseAgentBrowserOperation } from "./agent-browser-command";

describe("purchase-agent browser commands", () => {
  it("makes capture restart-safe with the server-selected work URL", () => {
    expect(
      resolvePurchaseAgentBrowserOperation(
        { kind: "capture_order" },
        "https://orders.example.test/history",
        ["orders.example.test"],
      ),
    ).toEqual({
      type: "capture",
      allowedHosts: ["orders.example.test"],
      enhancedEvidence: false,
      recoveryURL: "https://orders.example.test/history",
    });
  });

  it("keeps an explicit bounded target ahead of the claimed fallback", () => {
    expect(
      resolvePurchaseAgentBrowserOperation(
        {
          kind: "capture_pdf",
          target: "https://orders.example.test/order/123",
        },
        "https://orders.example.test/history",
        ["orders.example.test"],
      ),
    ).toMatchObject({
      type: "capture",
      enhancedEvidence: true,
      recoveryURL: "https://orders.example.test/order/123",
    });
  });
});
