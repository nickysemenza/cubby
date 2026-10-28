import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import { browserOperationPath } from "~/lib/browser-operation-path";
import {
  API_AUTH,
  BROWSER_AUTH,
  type Channel,
  type Principal,
} from "~/server/http/authenticate";
import type { AuthenticatedStartOperationContext } from "~/server/operation-runtime/start-operation.server";

import { createOperationDispatch } from "./operation-dispatch.server";

const principal = (channel: Channel, responseHeaders = new Headers()) =>
  fromPartial<Principal>({
    channel,
    credential: channel === "browser" ? "cookie" : "api-key",
    context: fromPartial<AuthenticatedStartOperationContext>({}),
    client: null,
    delegation: null,
    budget: null,
    session: null,
    responseHeaders,
  });

const post = (operation: string, headers: HeadersInit = {}) =>
  new Request(`https://cubby.example${browserOperationPath(operation)}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ operation, input: {} }),
  });

describe("operation endpoint", () => {
  it("answers plain JSON and refuses internal operations to API clients", async () => {
    const handler = vi.fn(async () => ({ ok: true as const, data: null }));
    const loadOperationHandler = vi.fn(async () => handler);
    const authenticate = vi.fn(async () => principal("cli"));
    const { handleOperationRequest } = createOperationDispatch({
      authenticate,
      loadOperationHandler,
    });
    const request = post("entity.detail", { "x-api-key": "synthetic-key" });
    const response = await handleOperationRequest(request);

    expect(response.status).toBe(200);
    expect(authenticate).toHaveBeenCalledWith(request, API_AUTH);
    expect(loadOperationHandler).toHaveBeenCalledWith("entity.detail");
    expect(await response.json()).toEqual({ ok: true, data: null });

    // Apple, the CLI and API keys see only capability and view operations.
    const internal = await handleOperationRequest(
      post("calendar.getCredential"),
    );
    expect(internal.status).toBe(404);
    expect(await internal.json()).toMatchObject({
      code: "NOT_FOUND",
      reason: "OPERATION_NOT_FOUND",
    });
    expect(loadOperationHandler).toHaveBeenCalledOnce();
  });

  it("selects browser auth from the surface header and forwards auth headers", async () => {
    const authenticate = vi.fn(async () =>
      principal("browser", new Headers({ "set-auth-token": "rotated-token" })),
    );
    const { handleOperationRequest } = createOperationDispatch({
      authenticate,
      loadOperationHandler: async () => async () => ({
        ok: false,
        error: { code: "CONFLICT", message: "Synthetic conflict" },
      }),
    });
    const request = post("calendar.getCredential", {
      "x-cubby-surface": "browser",
    });
    const response = await handleOperationRequest(request);

    // The browser's writes audit as `web`, and it reaches internal plumbing.
    expect(authenticate).toHaveBeenCalledWith(request, BROWSER_AUTH);
    expect(response.status).toBe(409);
    expect(response.headers.get("set-auth-token")).toBe("rotated-token");
    expect(await response.json()).toEqual({
      code: "CONFLICT",
      message: "Synthetic conflict",
    });
  });

  it("renders an authentication challenge without dispatching", async () => {
    const loadOperationHandler = vi.fn();
    const { handleOperationRequest } = createOperationDispatch({
      authenticate: async () => ({
        status: 403,
        code: "FORBIDDEN",
        message: "Same-origin request required",
      }),
      loadOperationHandler,
    });
    const response = await handleOperationRequest(post("entity.mutate"));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "FORBIDDEN",
      diagnostics: { operation: "dispatch", stage: "context" },
    });
    expect(loadOperationHandler).not.toHaveBeenCalled();
  });

  it("streams a workflow subscription as NDJSON result envelopes", async () => {
    const loadWorkflowStreamHandler = vi.fn(
      async () => async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({
              ok: true as const,
              data: { at: new Date("2026-01-02T03:04:05.000Z") },
            });
            controller.enqueue({
              ok: false as const,
              error: { code: "INTERNAL_SERVER_ERROR", message: "Stopped" },
              readMarker: "synthetic-marker",
            });
            controller.close();
          },
        }),
    );
    const { handleOperationRequest } = createOperationDispatch({
      authenticate: async () => principal("browser"),
      loadWorkflowStreamHandler,
    });
    const response = await handleOperationRequest(
      post("product.createMany", { "x-cubby-surface": "browser" }),
    );

    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    expect(
      (await response.text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { ok: true, data: { at: "2026-01-02T03:04:05.000Z" } },
      {
        ok: false,
        error: { code: "INTERNAL_SERVER_ERROR", message: "Stopped" },
        readMarker: "synthetic-marker",
      },
    ]);
    expect(loadWorkflowStreamHandler).toHaveBeenCalledWith(
      "product.createMany",
    );
  });
});
