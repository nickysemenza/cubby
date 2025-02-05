import { expectTypeOf, test } from "vitest";
import { type z } from "zod";
import { type amount } from "./codec";

test("amounts are the same type", () => {
  expectTypeOf<PrismaJson.Amount>().toMatchTypeOf<z.infer<typeof amount>>();
});
