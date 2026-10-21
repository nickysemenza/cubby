import { describe, expect, it } from "vitest";

import {
  scrubCredentialValues,
  scrubErrorMessage,
} from "./scrub-error-message";

const scrub = scrubCredentialValues;

describe("scrubCredentialValues", () => {
  it("scrubs credential labels inside escaped JSON messages and encoded keys", () => {
    const message = JSON.stringify({
      code: "UPSTREAM_ERROR",
      message: 'failure: {"password":"synthetic-secret"}',
    });
    expect(scrubErrorMessage(message)).not.toContain("synthetic-secret");
    const nested = JSON.stringify({ message: JSON.stringify({ message }) });
    expect(scrubErrorMessage(nested)).not.toContain("synthetic-secret");
    expect(
      scrubErrorMessage('{"pass\\u0077ord":"synthetic-secret"}'),
    ).not.toContain("synthetic-secret");
    const ordinary = '{ "message": "Synthetic failure", "status": 503 }';
    expect(scrubErrorMessage(ordinary)).toBe(ordinary);
    const escapedQuote = JSON.stringify({
      password: 'prefix"synthetic-secret',
    });
    expect(JSON.parse(scrubErrorMessage(escapedQuote))).toEqual({
      password: "[REDACTED]",
    });
    expect(scrubErrorMessage(`failure: ${escapedQuote}`)).not.toContain(
      "synthetic-secret",
    );
    expect(
      scrubErrorMessage(
        JSON.stringify({ message: `failure: ${escapedQuote}` }),
      ),
    ).not.toContain("synthetic-secret");
  });
  it("preserves diagnostic tails beyond 2000 characters while scrubbing credentials", () => {
    const prefix = "x".repeat(4000);
    expect(
      scrubErrorMessage(`${prefix} password=synthetic-secret SQLSTATE 53300`),
    ).toBe(`${prefix} password=[REDACTED] SQLSTATE 53300`);
  });

  it("keeps product names and prose that share a credential label", () => {
    for (const text of [
      "Basic Tee, size M",
      "Cookie: Chocolate Chip 12ct",
      "Victoria's Secret: order #1234",
      "Bearer of the synthetic parcel",
      "Token: delivered",
      "Basic Subscription",
      "Spotify Basic plan",
    ])
      expect(scrub(text)).toBe(text);
  });

  it("redacts token-shaped header and scheme values", () => {
    expect(scrub("Authorization: Bearer synthetic-bearer-0000")).toBe(
      "Authorization: [REDACTED]",
    );
    expect(scrub('{"authorization":"Basic c3ludGhldGljOmZpeHR1cmU="}')).toBe(
      '{"authorization":"[REDACTED]"}',
    );
    expect(scrub("Cookie: session=synthetic-cookie-value")).toBe(
      "Cookie: [REDACTED]",
    );
    expect(scrub("upstream said Bearer synthetic-bearer-0000")).toBe(
      "upstream said Bearer [REDACTED]",
    );
    expect(scrub("Basic c3ludGhldGljOmZpeHR1cmU=")).toBe("Basic [REDACTED]");
  });

  it("redacts short credentials that prose cannot be confused with", () => {
    expect(scrub("Authorization: Basic dXNlcjpwYXNz")).toBe(
      "Authorization: [REDACTED]",
    );
    expect(scrub("upstream said Basic dXNlcjpwYXNz")).toBe(
      "upstream said Basic [REDACTED]",
    );
    expect(scrub("Authorization: ApiKey abc-1234")).toBe(
      "Authorization: [REDACTED]",
    );
    expect(scrub("body: bearer abcdef0123456789abcdef")).toBe(
      "body: bearer [REDACTED]",
    );
    expect(scrub("password: hunter")).toBe("password: [REDACTED]");
  });

  it("stops query and labelled values at JSON and HTML delimiters", () => {
    expect(
      scrub(
        '{"src":"https://shop.invalid/a.js?key=synthetic-key","name":"Synthetic Market"}',
      ),
    ).toBe(
      '{"src":"https://shop.invalid/a.js?key=[REDACTED]","name":"Synthetic Market"}',
    );
    expect(scrub("<a href='https://x.invalid/?token=abc123'>Order</a>")).toBe(
      "<a href='https://x.invalid/?token=[REDACTED]'>Order</a>",
    );
    expect(scrub('password=synthetic-pass"tail')).toBe(
      'password=[REDACTED]"tail',
    );
  });

  it("keeps pagination tokens and redacts secret query parameters", () => {
    const pages =
      "https://api.invalid/orders?page_token=p2&next_token=n3&continuation-token=c4&pageToken=p5&next_page_token=p6";
    expect(scrub(pages)).toBe(pages);
    expect(scrub("https://api.invalid/?access_token=synthetic&page=2")).toBe(
      "https://api.invalid/?access_token=[REDACTED]&page=2",
    );
  });

  it("keeps slugs and SKUs while redacting vendor-prefixed keys", () => {
    for (const text of [
      "sk-ultrawide-monitor-27in-2026",
      "AKIA0000000000000000-extra",
    ])
      expect(scrub(text)).toBe(text);
    expect(scrub("key sk-syntheticfixturekey000000000 rejected")).toBe(
      "key [REDACTED] rejected",
    );
    expect(scrub("key sk-ant-synthetic-fixture-key-0000 rejected")).toBe(
      "key [REDACTED] rejected",
    );
    expect(scrub("id AKIA0000000000000000 denied")).toBe(
      "id [REDACTED] denied",
    );
  });

  it("keeps SQL placeholders but redacts labelled literals", () => {
    const sql = "select * from session where token = $1 and secret=$2";
    expect(scrub(sql)).toBe(sql);
    expect(scrub("token = synthetic-literal-1")).toBe("token = [REDACTED]");
    expect(scrub('{"apiKey":"synthetic-key"}')).toBe('{"apiKey":"[REDACTED]"}');
  });

  // A quadratic pattern took seconds on this input; the bound leaves headroom for loaded CI runners.
  it("redacts URL userinfo in linear time on long hyphen runs", () => {
    expect(scrub("postgres://user:synthetic@db.invalid/x")).toBe(
      "postgres://[REDACTED]@db.invalid/x",
    );
    const run = "-".repeat(40_000);
    const started = performance.now();
    expect(scrub(run)).toBe(run);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
