import { expectTypeOf, test } from "vitest";
import { type Amount } from "./codec";

test("amounts are the same type", () => {
  expectTypeOf<PrismaJson.Amount>().toMatchTypeOf<Amount>();
});
