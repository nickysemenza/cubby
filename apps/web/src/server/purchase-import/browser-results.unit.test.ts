import { describe, expect, it } from "vitest";

import { browserRecovery } from "./browser-results";

const observation = {
  url: "https://shop.example.test/orders",
  title: "Orders",
  readyState: "complete" as const,
  window: { recovered: false, minimized: true, onScreen: false },
  screenRecording: "granted" as const,
  durationMs: 1_200,
};
const failed = (
  code: Parameters<typeof browserRecovery>[0]["code"],
  screenshotGap: Parameters<typeof browserRecovery>[0]["screenshotGap"] = null,
  retryable = true,
) => ({
  status: "failed" as const,
  code,
  message: "synthetic failure",
  retryable,
  screenshotGap,
  observation,
});

// A capture that failed because the Mac's window was minimized once stalled
// a run with no reason. The server now decides: raise and retry once, then
// pause naming what the member can do; member-only fixes pause at once.
describe("the server's browser recovery policy", () => {
  it("raises a hidden window and retries a screenshot once, then pauses with the reason", () => {
    expect(
      browserRecovery(failed("screenshot_unavailable", "window_minimized"), 0),
    ).toEqual({
      action: "retry",
      raiseWindow: true,
    });
    expect(
      browserRecovery(failed("screenshot_unavailable", "window_not_found"), 0),
    ).toEqual({
      action: "retry",
      raiseWindow: false,
    });
    expect(
      browserRecovery(failed("screenshot_unavailable", "window_off_screen"), 1),
    ).toMatchObject({
      action: "pause",
      status: "paused_offline",
      reason: expect.stringContaining("window_off_screen"),
    });
  });

  it("pauses at once for a fix only the member can make", () => {
    expect(
      browserRecovery(
        failed("screenshot_unavailable", "screen_recording_denied"),
        0,
      ),
    ).toMatchObject({
      action: "pause",
      reason: expect.stringContaining("Screen"),
    });
    expect(
      browserRecovery(failed("javascript_disabled", null, false), 0),
    ).toMatchObject({
      action: "pause",
      reason: expect.stringContaining("Allow JavaScript from Apple Events"),
    });
  });

  it("stops for an outdated app and fails a command the Mac refused outright", () => {
    expect(
      browserRecovery(failed("client_update_required", null, false), 0),
    ).toEqual({
      action: "stop_outdated_client",
    });
    expect(browserRecovery(failed("disallowed_url", null, false), 0)).toEqual({
      action: "fail",
    });
  });
});
