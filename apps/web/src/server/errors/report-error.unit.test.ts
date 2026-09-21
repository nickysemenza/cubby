import { describe, expect, it, vi } from "vitest";

import { reportServerError, withErrorReporting } from "./report-error";

const capture = vi.fn(() => crypto.randomUUID());

describe("request error reporting", () => {
  it("returns each request's capture and deduplicates nested reporting", async () => {
    capture.mockClear();
    const error = new Error("same error object reused by two requests");
    const results = await Promise.all(
      ["one", "two"].map((requestId) =>
        withErrorReporting(
          async () => {
            const id = reportServerError(error, {
              requestId,
              operation: "entity.list",
            });
            await Promise.resolve();
            expect(reportServerError(error)).toBe(id);
            return id;
          },
          undefined,
          capture,
        ),
      ),
    );
    expect(new Set(results).size).toBe(2);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("keeps distinct batch failures separate even when a dependency rethrows one object", () => {
    capture.mockClear();
    withErrorReporting(
      () => {
        const error = new Error("upstream unavailable");
        const first = reportServerError(error, {
          operation: "batch_update",
          batchIndex: 0,
        });
        const second = reportServerError(error, {
          operation: "batch_update",
          batchIndex: 1,
        });
        expect(first).not.toBe(second);
      },
      undefined,
      capture,
    );
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("does not capture expected refusals or cancellation, and tolerates SDK failure", () => {
    capture.mockClear();
    expect(reportServerError({ code: "BAD_REQUEST" })).toBeUndefined();
    expect(
      reportServerError(new DOMException("cancelled", "AbortError")),
    ).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
    capture.mockImplementationOnce(() => {
      throw new Error("SDK unavailable");
    });
    expect(
      withErrorReporting(
        () => reportServerError(new Error("original")),
        undefined,
        capture,
      ),
    ).toBeUndefined();
  });
});
