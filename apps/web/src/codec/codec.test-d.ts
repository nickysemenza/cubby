import { expectTypeOf, test } from "vitest";
import { type Amount } from "./codec";
import { WAmount } from "@recipehub/recipebridge";

test("amounts are the same type", () => {
  expectTypeOf<PrismaJson.Amount>().toMatchTypeOf<Amount>();
  expectTypeOf<WAmount>().toMatchTypeOf<Amount>();
});
