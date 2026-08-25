import { describe, expect, it, vi } from "vitest";
import { recordObservedInput } from "./observed-request";

describe("observed request input redaction", () => {
  it("redacts URL/URI and credential values while retaining safe fields", () => {
    const setAttribute = vi.fn();
    recordObservedInput({ setAttribute } as never, {
      sourceUrl: "https://example.test/recipe?token=secret",
      callbackUri: "https://example.test/callback",
      apiKey: "secret",
      query: "pasta",
    });

    expect(setAttribute).toHaveBeenCalledWith(
      "rpc.input.sourceUrl",
      "[redacted]",
    );
    expect(setAttribute).toHaveBeenCalledWith(
      "rpc.input.callbackUri",
      "[redacted]",
    );
    expect(setAttribute).toHaveBeenCalledWith("rpc.input.apiKey", "[redacted]");
    expect(setAttribute).toHaveBeenCalledWith("rpc.input.query", "pasta");
  });
});
