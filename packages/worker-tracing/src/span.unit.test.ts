import { describe, expect, it, vi } from "vitest";

import * as nativeTracing from "./index";
import { piTelemetry } from "./pi";

import {
  type CfSpan,
  type CfTracing,
  enterInvocationSpan,
  enterSpan,
} from "./span";

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

describe("enterInvocationSpan", () => {
  // Entry annotations must work before a custom span exists, resolve each
  // invocation afresh, and never end the platform-owned root span.
  it("annotates fresh invocation roots and retains child timing attributes", async () => {
    const roots = [fakeTracing(), fakeTracing()];
    const child = fakeTracing();
    let invocation = 0;
    let ended = false;
    const tracing: CfTracing = {
      ...child.tracing,
      getActiveSpan: () => ({
        isTraced: true,
        setAttribute: (key, value) => roots[invocation]?.attrs.set(key, value),
        end: () => {
          ended = true;
        },
      }),
    };
    await enterInvocationSpan(tracing, "queue", async () => "ok", {
      attributes: { workload: "queue", absent: undefined },
    });
    invocation = 1;
    const failure = new Error("synthetic failure");
    await expect(
      enterInvocationSpan(
        tracing,
        "alarm",
        async () => {
          throw failure;
        },
        { attributes: { workload: "alarm" } },
      ),
    ).rejects.toBe(failure);
    expect([...roots[0]!.attrs]).toEqual([["workload", "queue"]]);
    expect([...roots[1]!.attrs]).toEqual([["workload", "alarm"]]);
    expect(child.attrs.get("workload")).toBe("alarm");
    expect(child.attrs.get("error")).toBe(true);
    expect(ended).toBe(false);
  });

  it("runs work when the runtime has no active invocation span", async () => {
    const { tracing } = fakeTracing();
    await expect(
      enterInvocationSpan(tracing, "work", async () => "ok"),
    ).resolves.toBe("ok");
  });
});

describe("Pi telemetry privacy", () => {
  it("keeps content and provider diagnostics out of native spans and preserves failures", async () => {
    const { attrs, tracing } = fakeTracing();
    const native = vi
      .spyOn(nativeTracing, "loadWorkerTracing")
      .mockResolvedValue(tracing);
    const error = new Error("synthetic private prompt");
    const telemetry = await piTelemetry(() => ({
      "cubby.run.kind": "mail_import",
    }));
    try {
      let callbackStarted = false;
      const result = telemetry.startSpan(
        {
          name: "pi.ai.request",
          attributes: { model: "synthetic/model", prompt: "synthetic prompt" },
        },
        (span) => {
          callbackStarted = true;
          span.setAttributes({
            "usage.input": 23,
            completion: "synthetic answer",
          });
          span.addEvent("pi.ai.block", {
            tool: "synthetic_tool",
            arguments: "synthetic input",
          });
          span.setStatus({
            status: "error",
            error: { name: "provider_error", message: error.message },
          });
          throw error;
        },
      );
      expect(callbackStarted).toBe(true);
      await expect(result).rejects.toBe(error);
      expect(Object.fromEntries(attrs)).toEqual({
        "cubby.run.kind": "mail_import",
        model: "synthetic/model",
        "usage.input": 23,
        "event.pi.ai.block.count": 1,
        "event.pi.ai.block.tool": "synthetic_tool",
        status: "error",
        error: true,
        "error.type": "Error",
      });
    } finally {
      native.mockRestore();
    }
  });
});
