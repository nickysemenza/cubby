import { describe, expect, it } from "vitest";

import { decodeBrowserBridgeMessage } from "./contracts";

const hello = {
  protocolVersion: 4,
  type: "hello",
  deviceID: "11111111-1111-4111-8111-111111111111",
  browser: "chrome",
  capabilities: {
    snapshotVersion: 1,
    screenshot: true,
    actions: [
      "navigate",
      "read",
      "click",
      "type",
      "select",
      "scroll",
      "window",
    ],
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
        JSON.stringify({ ...hello, protocolVersion: 3 }),
      ).success,
    ).toBe(false);
  });

  // Swift's generated client omits nil keys rather than sending null; a
  // result missing them must still parse, reading each as null.
  it("reads nullable keys Swift Codable omitted as null", () => {
    const decoded = decodeBrowserBridgeMessage(
      JSON.stringify({
        protocolVersion: 4,
        type: "result",
        result: {
          protocolVersion: 4,
          commandID: "22222222-2222-4222-8222-222222222222",
          operationID: "browser-command:capture-001",
          runID: "33333333-3333-4333-8333-333333333333",
          completedAt: "2026-09-20T15:00:00Z",
          outcome: {
            status: "failed",
            code: "browser_unavailable",
            message: "Chrome is not running",
            retryable: true,
            observation: { screenRecording: "unknown", durationMs: 12 },
          },
        },
      }),
    );
    expect(decoded.data).toMatchObject({
      result: {
        outcome: {
          screenshotGap: null,
          observation: {
            url: null,
            title: null,
            readyState: null,
            window: null,
          },
        },
      },
    });
  });
});
