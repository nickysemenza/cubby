import { describe, expect, it } from "vitest";

import { scrubSentryEvent } from "./sentry-scrub";

describe("scrubSentryEvent", () => {
  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:4173",
    "http://127.0.0.2:4173",
    "http://[::1]:4173",
    "https://preview.localhost:4173",
    "http://localhost.:4173",
  ])("labels built local requests as development: %s", (origin) => {
    const event = scrubSentryEvent({
      environment: "production",
      request: { url: `${origin}/products/PRD-TEST?token=secret` },
    });
    expect(event.environment).toBe("development");
    expect(event.request.url).toBe(
      `${origin}/products/:shortcode?token=[REDACTED]`,
    );
  });

  it.each([
    "https://app.example/products/PRD-TEST",
    "https://preview.example.workers.dev/products/PRD-TEST",
    "https://localhost.example/products/PRD-TEST",
    "https://127.0.0.1.example/products/PRD-TEST",
    "/products/PRD-TEST",
    "not an absolute URL",
    undefined,
  ])(
    "preserves the configured environment without local evidence: %s",
    (url) => {
      const event = scrubSentryEvent({
        environment: "production",
        request: { url },
      });
      expect(event.environment).toBe("production");
    },
  );

  it("preserves an explicitly configured test environment on loopback", () => {
    expect(
      scrubSentryEvent({
        environment: "test",
        request: { url: "http://localhost:4173/" },
      }).environment,
    ).toBe("test");
  });

  it("reuses route templates and removes credential query values", () => {
    const event = scrubSentryEvent({
      request: {
        url: "/api/calendar/private-token/private-feed?token=secret&view=month",
        query_string: "token=secret&view=month",
      },
    });

    expect(event.request.url).toBe(
      "/api/calendar/:token/:feed?token=[REDACTED]&view=month",
    );
    expect(event.request.query_string).toBe("token=[REDACTED]&view=month");
  });

  it("fails unknown paths closed", () => {
    const event = scrubSentryEvent({
      request: { url: "/future/private-id/private-note" },
    });

    expect(event.request.url).toBe("/:unmatched");
  });

  it("preserves an absolute origin while templating its path", () => {
    const event = scrubSentryEvent({
      request: { url: "https://cubby.example/products/PRD-SECRET" },
    });

    expect(event.request.url).toBe("https://cubby.example/products/:shortcode");
  });
});
