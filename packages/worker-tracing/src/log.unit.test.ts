import { describe, expect, it, vi } from "vitest";

import { createLogger, originalLoggedError } from "./log";

const sink = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe("createLogger", () => {
  it("prefixes the scope and passes fields as the trailing argument", () => {
    const out = sink();
    createLogger("UPC Lookup", {}, out).warn("Failed for 042", { status: 503 });
    expect(out.warn).toHaveBeenCalledWith("[UPC Lookup] Failed for 042", {
      status: 503,
    });
  });

  it("logs a bare message when there are no fields", () => {
    const out = sink();
    createLogger("x", {}, out).info("hello");
    expect(out.info).toHaveBeenCalledWith("[x] hello");
  });

  it("carries child fields on every entry, overridable per call", () => {
    const out = sink();
    const log = createLogger("x", {}, out).child({ upc: "042", attempt: 1 });
    log.error("boom", { attempt: 2 });
    expect(out.error).toHaveBeenCalledWith("[x] boom", {
      upc: "042",
      attempt: 2,
    });
  });

  it("keeps native error diagnostics in the JSON consumed by Workers logs", () => {
    const out = sink();
    const driver = Object.assign(new Error("constraint failed"), {
      code: "23505",
    });
    const error = Object.assign(new Error("Failed query", { cause: driver }), {
      query: "select * from example where label = $1",
      params: ["synthetic fixture"],
    });
    createLogger("request", {}, out).error("failed", { error });
    expect(originalLoggedError(out.error.mock.calls[0]?.[1].error)).toBe(error);
    const payload = JSON.stringify(out.error.mock.calls[0]?.[1]);
    expect(JSON.parse(payload)).toMatchObject({
      error: {
        name: "Error",
        message: "Failed query",
        stack: expect.stringContaining("Failed query"),
        cause: { message: "constraint failed", code: "23505" },
        query: "select * from example where label = $1",
        params: ["synthetic fixture"],
      },
    });
  });

  it("scrubs credentials through nested diagnostics without dropping SQL parameters", () => {
    const out = sink();
    const error = new Error("Authorization: Bearer synthetic-token", {
      cause: new Error("postgres://user:synthetic-password@db.invalid/example"),
    });
    createLogger("request", { token: "synthetic-token" }, out).warn("failed", {
      errors: [error],
      params: ["synthetic fixture"],
      headers: { authorization: "Bearer synthetic-token" },
    });
    const payload = JSON.stringify(out.warn.mock.calls[0]?.[1]);
    expect(payload).not.toContain("synthetic-token");
    expect(payload).not.toContain("synthetic-password");
    expect(payload).toContain("synthetic fixture");
    expect(payload).toContain("[REDACTED]");
  });

  it("scrubs credentials when an exception is logged as the message", () => {
    const out = sink();
    createLogger("request", {}, out).error(
      "upstream failed: Bearer synthetic-token",
    );
    expect(out.error).toHaveBeenCalledWith(
      "[request] upstream failed: Bearer [REDACTED]",
    );
  });

  it("bounds wide diagnostic collections while keeping complete SQL diagnostics", () => {
    const out = sink();
    const message = `Failed query: ${"synthetic SQL ".repeat(300)}`;
    createLogger("request", {}, out).error(message, {
      error: new Error(message),
      params: Array.from({ length: 10_000 }, () => "synthetic fixture"),
    });
    expect(out.error.mock.calls[0]?.[0]).toBe(`[request] ${message}`);
    const fields = out.error.mock.calls[0]?.[1];
    expect(fields.error.message).toBe(message);
    expect(fields.params.length).toBeLessThanOrEqual(1001);
    expect(fields.params.at(-1)).toBe("[Truncated]");
  });

  it("logs cyclic aggregate causes and hostile getters without replacing the failure", () => {
    const out = sink();
    const error = new AggregateError(
      [new Error("nested failure")],
      "outer failure",
    );
    error.cause = error;
    Object.defineProperty(error, "unreadable", {
      enumerable: true,
      get() {
        throw new Error("getter failed");
      },
    });
    expect(() =>
      createLogger("request", {}, out).error("failed", { error }),
    ).not.toThrow();
    expect(() => JSON.stringify(out.error.mock.calls[0]?.[1])).not.toThrow();
    expect(JSON.stringify(out.error.mock.calls[0]?.[1])).toContain(
      "nested failure",
    );
  });
});
