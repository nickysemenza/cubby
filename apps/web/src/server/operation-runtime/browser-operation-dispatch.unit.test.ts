import { fromPartial } from "@total-typescript/shoehorn";
import superjson from "superjson";
import { describe, expect, it, vi } from "vitest";

import { browserOperationPath } from "~/lib/browser-operation-path";
import { API_AUTH, type Principal } from "~/server/http/authenticate";
import type { AuthenticatedStartOperationContext } from "~/server/operation-runtime/start-operation.server";

import { createBrowserOperationHandler } from "./browser-operation-dispatch";

const principal = (responseHeaders = new Headers()) =>
  fromPartial<Principal>({
    channel: "cli",
    credential: "api-key",
    context: fromPartial<AuthenticatedStartOperationContext>({}),
    client: null,
    delegation: null,
    budget: null,
    session: null,
    responseHeaders,
  });

describe("shared operation route", () => {
  it("uses JSON by default and keeps nullable output as data", async () => {
    const run = vi.fn(async () => ({ ok: true as const, data: null as never }));
    const authenticate = vi.fn(async () => principal());
    const handle = createBrowserOperationHandler({
      authenticate,
      dispatch: run as never,
    });
    const request = new Request(
      `https://cubby.example${browserOperationPath("entity.detail")}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "synthetic-api-key",
        },
        body: JSON.stringify({ operation: "entity.detail", input: {} }),
      },
    );
    const response = await handle(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-cubby-value-codec")).toBeNull();
    expect(authenticate).toHaveBeenCalledWith(request, API_AUTH);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "entity.detail", input: {} }),
    );
    expect(await response.json()).toEqual({ ok: true, data: null });
  });

  it("answers in the requested superjson codec and forwards auth headers", async () => {
    const run = vi.fn(async () => ({ ok: true as const, data: "sample" }));
    const authenticate = vi.fn(async () =>
      principal(new Headers({ "set-auth-token": "rotated-token" })),
    );
    const handle = createBrowserOperationHandler({
      authenticate,
      dispatch: run as never,
    });
    const response = await handle(
      new Request(
        `https://cubby.example${browserOperationPath("dashboard.counts")}`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer synthetic-token",
            "x-cubby-value-codec": "superjson",
          },
          body: JSON.stringify(
            superjson.serialize({ operation: "dashboard.counts" }),
          ),
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-auth-token")).toBe("rotated-token");
    expect(response.headers.get("x-cubby-value-codec")).toBe("superjson");
    expect(superjson.deserialize(await response.json())).toEqual({
      ok: true,
      data: "sample",
    });
  });

  it("renders an authentication challenge without dispatching", async () => {
    const run = vi.fn(async () => ({ ok: true as const, data: null as never }));
    const authenticate = vi.fn(async () => ({
      status: 403 as const,
      code: "FORBIDDEN" as const,
      message: "Same-origin request required",
    }));
    const handle = createBrowserOperationHandler({
      authenticate,
      dispatch: run as never,
    });
    const request = new Request(
      `https://cubby.example${browserOperationPath("entity.mutate")}`,
      {
        method: "POST",
        headers: {
          cookie: "better-auth.session_token=synthetic-cookie",
          origin: "https://other.example",
        },
        body: JSON.stringify({ operation: "entity.mutate", input: {} }),
      },
    );
    const response = await handle(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "FORBIDDEN",
      diagnostics: { operation: "dispatch", stage: "context" },
    });
    expect(authenticate).toHaveBeenCalledWith(request, API_AUTH);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not expose internal operations over HTTP", async () => {
    const run = vi.fn(async () => ({ ok: true as const, data: null as never }));
    const handle = createBrowserOperationHandler({
      authenticate: async () => principal(),
      dispatch: run as never,
    });
    const response = await handle(
      new Request(
        `https://cubby.example${browserOperationPath("calendar.getCredential")}`,
        {
          method: "POST",
          body: JSON.stringify({ operation: "calendar.getCredential" }),
        },
      ),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(run).not.toHaveBeenCalled();
  });
});
