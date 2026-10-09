import { describe, expect, it } from "vitest";

import { parseSignal, renderSignal } from "./signals";

describe("agent signals", () => {
  it("renders queue events with escaped attributes and round-trips them", () => {
    const text = renderSignal({
      type: "purchase-import.browser_result",
      attributes: { eventId: 'browser-result:4K7M"x' },
      body: '{"commandId":"c-1"}',
    });
    expect(text).toContain('type="purchase-import.browser_result"');
    expect(text).toContain("browser-result:4K7M&quot;x");
    expect(parseSignal(text)).toEqual({
      type: "purchase-import.browser_result",
      attributes: { eventId: 'browser-result:4K7M"x' },
      body: '{"commandId":"c-1"}',
    });
  });

  it("does not mistake a member prompt for a signal", () => {
    expect(parseSignal("please <signal type=x> look again")).toBeUndefined();
  });
});
