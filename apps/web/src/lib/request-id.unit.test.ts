import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithRequestDiagnostics,
  getBrowserRequestDiagnostics,
  REQUEST_ID_HEADER,
} from "./request-id";

describe("request correlation header", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uses a neutral request-id header rather than claiming an OTel trace id", () => {
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });

  it("keeps out-of-order response ids paired with their own operations", async () => {
    vi.stubGlobal("window", {});
    const pending = new Map<string, (response: Response) => void>();
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const operation = new Headers(init?.headers).get("x-cubby-operation")!;
      return new Promise<Response>((resolve) =>
        pending.set(operation, resolve),
      );
    }) as typeof fetch;

    const first = fetchWithRequestDiagnostics(fetchImpl, "/_serverFn/first", {
      headers: { "x-cubby-operation": "entity.detail" },
    });
    const second = fetchWithRequestDiagnostics(fetchImpl, "/_serverFn/second", {
      headers: { "x-cubby-operation": "entity.list" },
    });
    pending.get("entity.list")!(
      new Response(null, { headers: { "x-request-id": "ray-list" } }),
    );
    pending.get("entity.detail")!(
      new Response(null, { headers: { "x-request-id": "ray-detail" } }),
    );
    await Promise.all([first, second]);

    expect(getBrowserRequestDiagnostics().slice(-2)).toEqual([
      expect.objectContaining({
        operation: "entity.list",
        requestId: "ray-list",
      }),
      expect.objectContaining({
        operation: "entity.detail",
        requestId: "ray-detail",
      }),
    ]);
  });
});
