import { describe, expect, it } from "vitest";

import {
  labelStartRequest,
  LEGACY_START_DISPATCH_ID,
  rewriteLegacyStartRequest,
} from "./start-dispatch-url";
import { startOperationHeaders } from "./start-operation-observability";

describe("Start request URLs", () => {
  it("labels a registered operation and entity without changing the body or headers", async () => {
    const controller = new AbortController();
    const request = new Request(
      "https://example.test/_serverFn/dispatch?existing=1",
      {
        method: "POST",
        body: "serialized-input",
        signal: controller.signal,
        headers: startOperationHeaders({
          operation: "entity.list",
          kind: "query",
          entity: "product",
        }),
      },
    );
    const labeled = labelStartRequest(request);
    expect(labeled).toBeInstanceOf(Request);
    if (!(labeled instanceof Request)) throw new Error("Expected request");
    expect(labeled.url).toBe(
      "https://example.test/_serverFn/dispatch?existing=1&operation=entity.list&entity=product",
    );
    expect(await labeled.text()).toBe("serialized-input");
    expect(labeled.method).toBe("POST");
    expect(labeled.headers.get("x-cubby-operation")).toBe("entity.list");
    controller.abort();
    expect(labeled.signal.aborted).toBe(true);
  });

  it("ignores unregistered labels and unrelated endpoints", () => {
    expect(
      labelStartRequest("/_serverFn/dispatch", {
        headers: { "x-cubby-operation": "unregistered" },
      }),
    ).toBe("/_serverFn/dispatch");
    expect(
      labelStartRequest("/api/example", {
        headers: startOperationHeaders({
          operation: "entity.list",
          kind: "query",
        }),
      }),
    ).toBe("/api/example");
  });

  it("internally rewrites only the old dispatcher, preserving a mutation payload", async () => {
    const request = new Request(
      `https://example.test/_serverFn/${LEGACY_START_DISPATCH_ID}?existing=1`,
      {
        method: "POST",
        body: "mutation",
        headers: { origin: "https://example.test" },
      },
    );
    const rewritten = rewriteLegacyStartRequest(request);
    expect(rewritten.url).toBe(
      "https://example.test/_serverFn/dispatch?existing=1",
    );
    expect(await rewritten.text()).toBe("mutation");
    expect(rewritten.headers.get("origin")).toBe("https://example.test");
    const other = new Request("https://example.test/_serverFn/other");
    expect(rewriteLegacyStartRequest(other)).toBe(other);
  });
});
