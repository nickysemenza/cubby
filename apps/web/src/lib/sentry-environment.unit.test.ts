import { describe, expect, it } from "vitest";

import { resolveWorkerSentryEnvironment } from "./sentry-environment";

describe("resolveWorkerSentryEnvironment", () => {
  it("honors the SENTRY_ENVIRONMENT var for a deployed origin", () => {
    expect(
      resolveWorkerSentryEnvironment({
        APP_ORIGIN: "https://cubby.nickysemenza.com",
        SENTRY_ENVIRONMENT: "development",
      }),
    ).toBe("development");
  });

  it("defaults to production when the var is absent", () => {
    expect(
      resolveWorkerSentryEnvironment({
        APP_ORIGIN: "https://cubby.nickysemenza.com",
      }),
    ).toBe("production");
  });

  it("lets E2E test mode win over the var", () => {
    expect(
      resolveWorkerSentryEnvironment({
        APP_ORIGIN: "https://cubby.nickysemenza.com",
        E2E_AUTH_TEST_MODE: "true",
        SENTRY_ENVIRONMENT: "production",
      }),
    ).toBe("test");
  });

  it("still reports development for a loopback origin despite the var", () => {
    expect(
      resolveWorkerSentryEnvironment({
        APP_ORIGIN: "http://127.0.0.1:8787",
        SENTRY_ENVIRONMENT: "production",
      }),
    ).toBe("development");
  });
});
