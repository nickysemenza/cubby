import { nativeCallbackSchemeSchema } from "@cubby/shared/apple-app-identity";
import { defaultParseSearch } from "@tanstack/react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { createCubbyAuthClient } from "./auth-client";
import { nativeAuthCallbackURLs, nativeAuthSearch } from "./native-auth";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(nativeCallbackSchemeSchema.options)(
  "returns the transfer cookie to the requesting %s app",
  (scheme) => {
    vi.useFakeTimers();
    const replace = vi.fn();
    vi.stubGlobal("document", {
      cookie: "better-auth.cubby-native=synthetic-transfer",
    });
    vi.stubGlobal("window", {
      location: {
        replace,
        origin: "https://app.example.test",
        href: "https://app.example.test/auth/native",
      },
    });
    createCubbyAuthClient(scheme).ensureElectronRedirect({ interval: 1 });
    vi.advanceTimersByTime(1);
    expect(replace).toHaveBeenCalledWith(
      `${scheme}://auth/callback#token=synthetic-transfer`,
    );
  },
);

it("preserves the Dev destination through successful OAuth and a retry", () => {
  const urls = nativeAuthCallbackURLs(
    "cubby-dev",
    "synthetic-state",
    "synthetic-challenge",
  );
  const completed = nativeAuthSearch.parse(
    defaultParseSearch(
      new URL(urls.callbackURL, "https://app.example.test").search,
    ),
  );
  const retry = nativeAuthSearch.parse(
    defaultParseSearch(
      new URL(urls.errorCallbackURL, "https://app.example.test").search,
    ),
  );
  expect(completed.callback_scheme).toBe("cubby-dev");
  expect(completed.complete).toBe(true);
  expect(retry.callback_scheme).toBe("cubby-dev");
  expect(retry.state).toBe("synthetic-state");
  expect(retry.code_challenge).toBe("synthetic-challenge");
  expect(retry.code_challenge_method).toBe("S256");
  expect(() =>
    nativeAuthSearch.parse({ callback_scheme: "javascript" }),
  ).toThrow(ZodError);
});
