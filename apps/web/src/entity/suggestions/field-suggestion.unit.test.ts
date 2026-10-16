import { describe, expect, it } from "vitest";

import { basisValueOf } from "./field-suggestion";

describe("structured suggestion basis", () => {
  it("serializes owned JSON objects without losing existing picker-id semantics", () => {
    const identity = { kind: "credit_card", issuer: null, network: "visa" };
    expect(basisValueOf(identity)).toBe(JSON.stringify(identity));
    expect(basisValueOf({ id: "chosen", label: "Chosen" })).toBe("chosen");
    expect(basisValueOf({ invalid: undefined })).toBeNull();
    const history = [
      { validFrom: "2026-01-01", validTo: null, note: "Synthetic history" },
    ];
    expect(basisValueOf(history)).toBe(JSON.stringify(history));
    expect(basisValueOf(["one", "two"])).toBe('["one","two"]');
  });
});
