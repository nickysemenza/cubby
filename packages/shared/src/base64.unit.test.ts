import { describe, expect, it } from "vitest";

import { encodeBase64 } from "./base64";

describe("encodeBase64", () => {
  it("encodes photo bytes without an argument-limit overflow", () => {
    const bytes = new Uint8Array(0x8001).fill(255);
    expect(encodeBase64(bytes)).toBe(btoa(String.fromCharCode(...bytes)));
  });
});
