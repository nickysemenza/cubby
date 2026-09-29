import { describe, expect, it } from "vitest";

import {
  resolveWorkerSentryEnvironment,
  workerSentryEnabled,
} from "./sentry-environment";

// Local sessions use real auth, so E2E_AUTH_TEST_MODE cannot suppress telemetry.
it("keeps local test telemetry off without enabling test authentication", () => {
  expect(
    workerSentryEnabled({
      SENTRY_ENVIRONMENT: "test",
      E2E_AUTH_TEST_MODE: "false",
    }),
  ).toBe(false);
  expect(
    workerSentryEnabled({
      SENTRY_ENVIRONMENT: "development",
      E2E_AUTH_TEST_MODE: "false",
    }),
  ).toBe(true);
  expect(workerSentryEnabled({ E2E_AUTH_TEST_MODE: "true" })).toBe(false);
});

describe("resolveWorkerSentryEnvironment", () => {
  it("honors the SENTRY_ENVIRONMENT var for a deployed origin", () => {
    expect(
      resolveWorkerSentryEnvironment({
        APP_ORIGIN: "https://cubby.nickysemenza.com",
        SENTRY_ENVIRONMENT: "development",
      }),
    ).toBe("development");
  });

  it("uses NODE_ENV when the preview override is absent", () => {
    expect(
      resolveWorkerSentryEnvironment({
        APP_ORIGIN: "https://cubby.nickysemenza.com",
        NODE_ENV: "production",
      }),
    ).toBe("production");
  });

  it("lets the local Cloudflare preview override a production build", () => {
    expect(
      resolveWorkerSentryEnvironment({
        APP_ORIGIN: "https://cubby.nickysemenza.com",
        NODE_ENV: "production",
        SENTRY_ENVIRONMENT: "development",
      }),
    ).toBe("development");
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
