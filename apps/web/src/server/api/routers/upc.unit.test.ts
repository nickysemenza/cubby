import { unsafeUserId } from "@cubby/schemas/identifiers";
import { describe, expect, it, vi } from "vitest";
import { createCallerFactory, createTestTRPCContext } from "~/server/api/trpc";
import type { Database } from "~/server/db";
import { upcRouter } from "./upc";

const db = undefined as unknown as Database;

describe("upc router authentication", () => {
  it("rejects anonymous proxy access", async () => {
    const caller = createCallerFactory(upcRouter)(createTestTRPCContext(db));
    await expect(caller.lookup({ upc: "012345678905" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("allows an authenticated lookup", async () => {
    const context = createTestTRPCContext(db, {
      auth: { userId: unsafeUserId("owner") },
    });
    context.upcLookupClient.lookup = vi.fn().mockResolvedValue(null);
    const caller = createCallerFactory(upcRouter)(context);
    await expect(caller.lookup({ upc: "012345678905" })).resolves.toBeNull();
  });
});
