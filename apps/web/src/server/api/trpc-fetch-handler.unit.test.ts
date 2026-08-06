import { initTRPC } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { handleTRPCFetchRequest } from "./trpc-fetch-handler";

const t = initTRPC.create();
const testRouter = t.router({
  echo: t.procedure.input(z.string()).query(({ input }) => input),
});

describe("handleTRPCFetchRequest", () => {
  it("allows a POST request to dispatch a query procedure", async () => {
    const response = await handleTRPCFetchRequest({
      endpoint: "/api/trpc",
      req: new Request("https://cubby.test/api/trpc/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify("large query input"),
      }),
      router: testRouter,
      createContext: () => ({}),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      result: { data: "large query input" },
    });
  });
});
