import { expectTypeOf, test } from "vitest";
import { type Amount } from "./codec";
import { WMeasure } from "@recipehub/recipebridge";

test("amounts are the same type", () => {
  expectTypeOf<PrismaJson.Amount>().toMatchTypeOf<Amount>();
  expectTypeOf<WMeasure>().toMatchTypeOf<Amount>();
});
