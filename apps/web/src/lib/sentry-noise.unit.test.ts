import { describe, expect, it } from "vitest";

import { SENTRY_IGNORED_ERRORS } from "./sentry-noise";

function isStringEntry(entry: string | RegExp): entry is string {
  return typeof entry === "string";
}

// Mirrors Sentry's own `ignoreErrors` matching: a string entry matches by
// substring, a RegExp entry matches via `.test()`. See
// https://docs.sentry.io/platforms/javascript/configuration/filtering/#using-ignoreerrors
const isIgnored = (message: string) =>
  SENTRY_IGNORED_ERRORS.some((entry) =>
    isStringEntry(entry) ? message.includes(entry) : entry.test(message),
  );

describe("SENTRY_IGNORED_ERRORS", () => {
  it.each([
    "The client has disconnected",
    "Jev request failed (429): Wholesale Rate limited",
    "VECTOR_UPSERT_ERROR (code = 40041): rate limited",
  ])("ignores known-noise message %s", (message) => {
    expect(isIgnored(message)).toBe(true);
  });

  it.each([
    "Jev request failed (500): x",
    "Failed query: select 1",
    "out of memory",
  ])("does not ignore unrelated message %s", (message) => {
    expect(isIgnored(message)).toBe(false);
  });
});
