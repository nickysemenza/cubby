import { describe, expect, it } from "vitest";
import { isRetryableNotionError } from "./notion";

// Regression guard for the error classification preserved when `queryWithRetry`
// moved from a hand-rolled backoff loop to `p-retry`. Only transient failures
// should be retried; everything else must reject on the first attempt.
describe("isRetryableNotionError", () => {
  it.each([
    "Request timed out",
    "Notion API responded with 504 Gateway Timeout",
    "502 Bad Gateway",
    "error code: rate_limited",
    "HTTP 429 Too Many Requests",
  ])("retries transient error: %s", (message) => {
    expect(isRetryableNotionError(new Error(message))).toBe(true);
  });

  it.each([
    "validation_error: body failed validation",
    "object_not_found",
    "unauthorized",
    "404 Not Found",
  ])("does not retry permanent error: %s", (message) => {
    expect(isRetryableNotionError(new Error(message))).toBe(false);
  });
});
