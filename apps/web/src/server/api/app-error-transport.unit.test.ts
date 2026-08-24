import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { AppError, createAppError } from "~/server/errors/app-error";
import {
  createTestCaller,
  createTestTRPCContext,
  createTRPCRouter,
  protectedProcedure,
} from "./trpc";

const router = createTRPCRouter({
  fail: protectedProcedure.query(() => {
    throw createAppError("PRODUCT_NOT_FOUND", "No product matched");
  }),
});

describe("AppError tRPC adapter", () => {
  it("keeps the domain error neutral before it reaches a transport", () => {
    const error = createAppError("PRODUCT_NOT_FOUND", "No product matched");
    expect(error).toBeInstanceOf(AppError);
    expect(error).not.toBeInstanceOf(TRPCError);
  });

  it("converts domain failures at the tRPC seam", async () => {
    const caller = createTestCaller(router, {} as Database);
    await expect(caller.fail()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "No product matched",
      cause: expect.objectContaining({
        reason: "PRODUCT_NOT_FOUND",
      }),
    });
  });

  it("converts authentication failures through the same adapter", async () => {
    const caller = router.createCaller(
      createTestTRPCContext({} as Database, { auth: undefined }),
    );
    await expect(caller.fail()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
