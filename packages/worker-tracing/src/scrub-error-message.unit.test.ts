import { describe, expect, it } from "vitest";

import { scrubCredentialValues } from "./scrub-error-message";

const scrub = scrubCredentialValues;

describe("scrubCredentialValues", () => {
  it("keeps product names and prose that share a credential label", () => {
    for (const text of [
      "Basic Tee, size M",
      "Cookie: Chocolate Chip 12ct",
      "Victoria's Secret: order #1234",
      "Bearer of the synthetic parcel",
      "Token: delivered",
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
      "https://api.invalid/orders?page_token=p2&next_token=n3&continuation-token=c4&pageToken=p5";
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

  it("redacts URL userinfo in linear time on long hyphen runs", () => {
    expect(scrub("postgres://user:synthetic@db.invalid/x")).toBe(
      "postgres://[REDACTED]@db.invalid/x",
    );
    const run = "-".repeat(40_000);
    const started = performance.now();
    expect(scrub(run)).toBe(run);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
