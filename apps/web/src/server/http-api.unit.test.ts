import { fromPartial } from "@total-typescript/shoehorn";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHttpApiHandler } from "./http-api-handler";

const ports = {
  getSession: vi.fn(),
  verifyApiKey: vi.fn(),
  context: vi.fn(),
  dispatch: vi.fn(),
};
const handleHttpOperation = createHttpApiHandler(
  fromPartial<Parameters<typeof createHttpApiHandler>[0]>({
    auth: { getSession: ports.getSession, verifyApiKey: ports.verifyApiKey },
    context: ports.context,
    dispatch: ports.dispatch,
  }),
);
const request = (path: string, init?: RequestInit) =>
  handleHttpOperation(
    new Request(`https://cubby.example/api/v1/${path}`, init),
  );

beforeEach(() => {
  vi.resetAllMocks();
  ports.getSession.mockResolvedValue({
    response: {
      user: { id: "user-fixture" },
      session: { id: "session-fixture", token: "token" },
    },
    headers: new Headers(),
  });
  ports.context.mockResolvedValue({});
  ports.dispatch.mockResolvedValue({ ok: true, data: {} });
});

describe("HTTP boundary", () => {
  it("distinguishes authenticated adapter failures from auth-provider failures", async () => {
    ports.context.mockRejectedValueOnce(
      new Error("Context service unavailable"),
    );
    const contextFailure = await request("recipes");
    expect(await contextFailure.json()).toMatchObject({
      message: "Context service unavailable",
      diagnostics: {
        operation: "entity.list",
        stage: "context",
        causes: [{ message: "Context service unavailable" }],
      },
    });
    ports.getSession.mockRejectedValueOnce(new Error("Private auth backend"));
    const authFailure = await request("recipes");
    const body = await authFailure.text();
    expect(JSON.parse(body)).toMatchObject({
      message: "The operation could not be completed",
      diagnostics: { causes: [] },
    });
    expect(body).not.toContain("Private auth backend");
  });

  it("verifies the session and lets the server choose the database read policy", async () => {
    expect((await request("recipes")).status).toBe(200);
    expect(ports.getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      returnHeaders: true,
    });
    expect(ports.context).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      actor: {
        userId: "user-fixture",
        sessionId: "session-fixture",
        channel: "api",
      },
    });
    expect(ports.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "entity.list",
        input: { entity: "recipe", filters: {} },
      }),
    );
  });

  it("forwards only Better Auth session-data cookies", async () => {
    const headers = new Headers();
    headers.append(
      "set-cookie",
      "better-auth.session_data.0=cache-a; Path=/; HttpOnly",
    );
    headers.append(
      "set-cookie",
      "better-auth.session_token=secret; Path=/; HttpOnly",
    );
    ports.getSession.mockResolvedValue({
      response: {
        user: { id: "user-fixture" },
        session: { id: "session-fixture", token: "token" },
      },
      headers,
    });

    const response = await request("recipes", {
      headers: { authorization: "Bearer token.signature" },
    });
    expect(response.headers.get("set-cookie")).toContain(
      "better-auth.session_data.0=cache-a",
    );
    expect(response.headers.get("set-cookie")).not.toContain("session_token");
  });

  it("forwards a refreshed bearer credential with session cache cookies", async () => {
    ports.getSession.mockResolvedValue({
      response: {
        user: { id: "user-fixture" },
        session: { id: "session-fixture", token: "token" },
      },
      headers: new Headers({ "set-auth-token": "token.new-signature" }),
    });
    const response = await request("recipes", {
      headers: { authorization: "Bearer token.signature" },
    });
    expect(response.headers.get("set-auth-token")).toBe("token.new-signature");
  });
  it.each(["", "invalid"])(
    "never falls back from an explicit rejected key (%s)",
    async (key) => {
      ports.verifyApiKey.mockResolvedValue({ valid: false });
      expect(
        (await request("recipes", { headers: { "x-api-key": key } })).status,
      ).toBe(401);
      expect(ports.getSession).not.toHaveBeenCalled();
      expect(ports.dispatch).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, "https://foreign.example"])(
    "rejects cookie writes before normalizing the Origin (%s)",
    async (origin) => {
      const headers = new Headers({ "content-type": "application/json" });
      if (origin) headers.set("Origin", origin);
      expect(
        (
          await request("recipes/RCP-ABCD", {
            method: "PATCH",
            headers,
            body: '{"name":"Change"}',
          })
        ).status,
      ).toBe(403);
      expect(ports.context).not.toHaveBeenCalled();
      expect(ports.dispatch).not.toHaveBeenCalled();
    },
  );
  it("lets verified keys write without an Origin and adapts only the body", async () => {
    ports.verifyApiKey.mockResolvedValue({
      valid: true,
      key: { configId: "http-api", referenceId: "user-fixture" },
    });
    expect(
      (
        await request("recipes/RCP-ABCD", {
          method: "PATCH",
          headers: { "x-api-key": "key", "content-type": "application/json" },
          body: '{"notes":"Changed"}',
        })
      ).status,
    ).toBe(200);
    expect(ports.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "entity.mutate",
        input: {
          action: "update",
          entity: "recipe",
          id: "RCP-ABCD",
          data: { notes: "Changed" },
        },
      }),
    );
    expect(ports.getSession).not.toHaveBeenCalled();
  });
  // Regression: the Vite dev server hands over srvx's NodeRequest, which
  // passes `instanceof Request` but carries no undici internal state, so
  // ts-rest's `new TsRestRequest(request)` threw on every write.
  it("accepts a foreign Request implementation carrying a body", async () => {
    const native = new Request(
      "https://cubby.example/api/v1/recipes/RCP-ABCD",
      {
        method: "PATCH",
        headers: {
          authorization: "Bearer token.signature",
          "content-type": "application/json",
        },
        body: '{"notes":"Changed"}',
      },
    );
    const foreign: Request = Object.create(Request.prototype, {
      url: { get: () => native.url },
      method: { get: () => native.method },
      headers: { get: () => native.headers },
      body: { get: () => native.body },
      bodyUsed: { get: () => native.bodyUsed },
      signal: { get: () => native.signal },
      text: { value: () => native.text() },
      json: { value: () => native.json() },
      arrayBuffer: { value: () => native.arrayBuffer() },
      clone: { value: () => native.clone() },
    });
    const response = await handleHttpOperation(foreign);
    expect(response.status).toBe(200);
    expect(ports.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ data: { notes: "Changed" } }),
      }),
    );
  });
  it("lets bearer-authenticated writes through without an Origin", async () => {
    const response = await request("recipes/RCP-ABCD", {
      method: "PATCH",
      headers: {
        authorization: "Bearer token.signature",
        "content-type": "application/json",
      },
      body: '{"notes":"Changed"}',
    });
    expect(response.status).toBe(200);
    // The bearer plugin turns the header into a session before getSession
    // runs, while the signed session cache can avoid a database lookup.
    expect(ports.getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      returnHeaders: true,
    });
    expect(ports.verifyApiKey).not.toHaveBeenCalled();
    expect(ports.context).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      actor: {
        userId: "user-fixture",
        sessionId: "session-fixture",
        channel: "api",
      },
    });
  });
  it("rejects a bearer token the auth layer does not recognise", async () => {
    ports.getSession.mockResolvedValue({
      response: null,
      headers: new Headers(),
    });
    expect(
      (
        await request("recipes", {
          headers: { authorization: "Bearer invalid" },
        })
      ).status,
    ).toBe(401);
    expect(ports.dispatch).not.toHaveBeenCalled();
  });
  it("still requires a same-origin write for non-bearer Authorization schemes", async () => {
    expect(
      (
        await request("recipes/RCP-ABCD", {
          method: "PATCH",
          headers: {
            authorization: "Basic dXNlcjpwYXNz",
            "content-type": "application/json",
          },
          body: '{"name":"Change"}',
        })
      ).status,
    ).toBe(403);
    expect(ports.dispatch).not.toHaveBeenCalled();
  });
  it.each([
    ["recipe/getManyByIDs?ids=RCP-ABCD", { ids: ["RCP-ABCD"] }],
    [
      "recipe/getManyByIDs?ids=RCP-ABCD&ids=RCP-EFGH",
      { ids: ["RCP-ABCD", "RCP-EFGH"] },
    ],
    // ts-rest's own client spells lists with brackets; the handler folds them.
    [
      "recipe/getManyByIDs?ids%5B0%5D=RCP-ABCD&ids%5B1%5D=RCP-EFGH",
      { ids: ["RCP-ABCD", "RCP-EFGH"] },
    ],
    ["recipe/getManyByIDs?ids%5B%5D=RCP-ABCD", { ids: ["RCP-ABCD"] }],
    ["dashboard/counts", undefined],
    [
      "recipes?page=1&pageSize=5",
      {
        entity: "recipe",
        filters: {},
        pagination: { pageIndex: 0, pageSize: 5 },
      },
    ],
  ])("decodes GET input for %s", async (path, input) => {
    expect((await request(path)).status).toBe(200);
    expect(ports.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ input }),
    );
  });
  // A domain blocker (e.g. PROJECT_HAS_TASKS, covered against PostgreSQL in
  // project.integration.test.ts) must reach an HTTP client as its own status
  // with the blockers intact, not as a generic 500.
  it.each([
    ["PRECONDITION_FAILED", 412],
    ["CONFLICT", 409],
    ["NOT_FOUND", 404],
  ] as const)(
    "answers a dispatched %s as %i with its body",
    async (code, status) => {
      const error = {
        code,
        message: "Blocked",
        reason: "PROJECT_HAS_TASKS",
        blockers: [{ id: "TSK-4K7M" }],
      };
      ports.dispatch.mockResolvedValueOnce({ ok: false, error });
      const response = await request("financial-accounts/FAC-4K7M", {
        method: "DELETE",
        headers: { origin: "https://cubby.example" },
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject(error);
      expect(ports.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            action: "delete",
            entity: "financialAccount",
          }),
        }),
      );
    },
  );
  it("resolves registered operation names before resource identifiers", async () => {
    expect((await request("image/detail?id=IMG-ABCD")).status).toBe(200);
    expect(ports.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "image.detail" }),
    );
  });
  it("returns 404 for invalid identifiers and 405 with supported methods", async () => {
    expect((await request("recipes/%ZZ")).status).toBe(404);
    expect((await request("recipes/VEN-ABCD")).status).toBe(404);
    const response = await request("recipes/RCP-ABCD", { method: "PUT" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, PATCH, DELETE");
  });
});
