import { type inferProcedureInput } from "@trpc/server";
import { expect, test } from "vitest";

import { appRouter, type AppRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";

test("example router", async () => {
  const ctx = await createTRPCContext({ headers: new Headers() });
  const caller = appRouter.createCaller(ctx);

  type Input = inferProcedureInput<AppRouter["demo"]["hello"]>;
  const input: Input = {
    text: "test",
  };

  const example = await caller.demo.hello(input);

  expect(example).toMatchObject({ greeting: "Hello, test!", fib: 6765 });
});
