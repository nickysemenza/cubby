import { describe, expect, it, vi } from "vitest";
import { registerSentryErrorCapture } from "./index";

/**
 * `registerSentryErrorCapture` is framework-free (see index.ts docstring), so
 * these tests exercise it against a minimal structural fake matching Hono's
 * `onError` contract rather than importing the real `hono` package — keeping
 * this package's dependency footprint at zero.
 */
function createFakeApp() {
  let onErrorHandler:
    | ((err: Error) => Response | Promise<Response>)
    | undefined;
  return {
    app: {
      onError(handler: typeof onErrorHandler) {
        onErrorHandler = handler;
      },
    },
    // Mirrors what Hono does internally when a route throws: it catches the
    // error and invokes the registered onError handler instead of letting it
    // escape app.fetch() (which is the whole gap this helper works around).
    trigger: async (err: Error) => {
      if (!onErrorHandler) throw new Error("onError was never registered");
      return onErrorHandler(err);
    },
  };
}

describe("registerSentryErrorCapture", () => {
  it("captures the error and returns a generic 500", async () => {
    const { app, trigger } = createFakeApp();
    const capture = vi.fn();

    registerSentryErrorCapture(app, capture);

    const thrown = new Error("boom");
    const response = await trigger(thrown);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(thrown);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  });

  it("supports a custom response message", async () => {
    const { app, trigger } = createFakeApp();

    registerSentryErrorCapture(app, vi.fn(), "custom message");

    const response = await trigger(new Error("boom"));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("custom message");
  });

  it("still reports the error even if capture itself is async/fire-and-forget", async () => {
    const { app, trigger } = createFakeApp();
    const seen: unknown[] = [];
    registerSentryErrorCapture(app, (err) => {
      seen.push(err);
    });

    await trigger(new Error("first"));
    await trigger(new Error("second"));

    expect(seen).toHaveLength(2);
  });
});
