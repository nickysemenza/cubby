import { describe, expect, it, vi } from "vitest";

import { createLogger } from "./log";

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
});
