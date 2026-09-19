import { describe, expect, it } from "vitest";

import { decodeBrowserBridgeMessage } from "./contracts";

const hello = {
  version: 1,
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
});
