import { describe, expect, it } from "vitest";

import { type CfSpan, type CfTracing, enterSpan } from "./span";

const fakeTracing = () => {
  const attrs = new Map<string, unknown>();
  const span: CfSpan = {
    isTraced: true,
    setAttribute: (key, value) => {
      attrs.set(key, value);
    },
    end: () => {},
  };
  const tracing: CfTracing = {
    enterSpan: (_name, cb) => cb(span),
    startActiveSpan: (_name, cb) => cb(span),
  };
  return { attrs, tracing };
};

describe("enterSpan", () => {
  it("applies attributes and skips undefined ones", async () => {
    const { attrs, tracing } = fakeTracing();
    await enterSpan(tracing, "work", async () => "ok", {
      attributes: { a: 1, b: undefined },
    });
    expect([...attrs]).toEqual([["a", 1]]);
  });

  // The span carries the exception TYPE only: a message can hold user data.
  it("marks a thrown error by type, not message, and rethrows", async () => {
    const { attrs, tracing } = fakeTracing();
    await expect(
      enterSpan(tracing, "work", async () => {
        throw new RangeError("secret detail");
      }),
    ).rejects.toThrow("secret detail");
    expect(attrs.get("error")).toBe(true);
    expect(attrs.get("error.type")).toBe("RangeError");
    expect(attrs.has("error.message")).toBe(false);
  });
});
