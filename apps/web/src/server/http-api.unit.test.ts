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
    user: { id: "user-fixture" },
    session: { id: "session-fixture" },
  });
  ports.context.mockResolvedValue({});
  ports.dispatch.mockResolvedValue({ ok: true, data: {} });
});

describe("HTTP boundary", () => {
  it("verifies sessions authoritatively and retains actor session identity", async () => {
    expect((await request("recipes")).status).toBe(200);
    expect(ports.getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      query: { disableCookieCache: true },
    });
    expect(ports.context).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      actor: {
        userId: "user-fixture",
        sessionId: "session-fixture",
        source: "api",
      },
    });
    expect(ports.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "entity.list",
        input: { entity: "recipe", filters: {} },
      }),
    );
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
  it("lets bearer-authenticated writes through without an Origin", async () => {
    expect(
      (
        await request("recipes/RCP-ABCD", {
          method: "PATCH",
          headers: {
            authorization: "Bearer token.signature",
            "content-type": "application/json",
          },
          body: '{"notes":"Changed"}',
        })
      ).status,
    ).toBe(200);
    // The bearer plugin turns the header into a session before getSession
    // runs, so the boundary still reads the session authoritatively.
    expect(ports.getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      query: { disableCookieCache: true },
    });
    expect(ports.verifyApiKey).not.toHaveBeenCalled();
    expect(ports.context).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      actor: {
        userId: "user-fixture",
        sessionId: "session-fixture",
        source: "api",
      },
    });
  });
  it("rejects a bearer token the auth layer does not recognise", async () => {
    ports.getSession.mockResolvedValue(null);
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
    ["recipe/getManyByIDs?ids=%5B%22RCP-ABCD%22%5D", { ids: ["RCP-ABCD"] }],
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
