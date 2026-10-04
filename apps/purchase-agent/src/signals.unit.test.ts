import { describe, expect, it } from "vitest";

import { parseSignal, renderSignal } from "./signals";

describe("agent signals", () => {
  // The workerd scripted model and its await markers match these exact bytes;
  // they are the format the coordinator was trained against under Flue.
  it("renders the finish nudge in the established wire format", () => {
    expect(
      renderSignal({ type: "run_not_finished", body: "Keep going." }),
    ).toBe('<signal type="run_not_finished">Keep going.</signal>');
  });

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
