import { describe, expect, it } from "vitest";
import { scrubSentryEvent } from "./sentry-scrub";

describe("scrubSentryEvent", () => {
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
