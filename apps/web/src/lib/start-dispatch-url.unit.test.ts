import { describe, expect, it } from "vitest";

import { labelStartRequest } from "./start-dispatch-url";
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
});
