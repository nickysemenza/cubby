import { describe, expect, it } from "vitest";

import { isDirectBrowserSocketUpgrade } from "./direct-socket-route";

describe("isDirectBrowserSocketUpgrade", () => {
  it("bypasses Start middleware only for the authenticated browser WebSocket route", () => {
    expect(
      isDirectBrowserSocketUpgrade(
        new Request(
          "https://cubby.example/api/import/agent/socket?vendorAccount=VACCT-EXAMPLE",
          { headers: { Upgrade: "websocket" } },
        ),
      ),
    ).toBe(true);
    expect(
      isDirectBrowserSocketUpgrade(
        new Request("https://cubby.example/api/import/agent/socket"),
      ),
    ).toBe(false);
    expect(
      isDirectBrowserSocketUpgrade(
        new Request("https://cubby.example/api/import/agent/accounts", {
          headers: { Upgrade: "websocket" },
        }),
      ),
    ).toBe(false);
  });
});
