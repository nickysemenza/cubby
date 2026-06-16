import {
  allProblemsSchema,
  ingredientWithPartialCoverageSchema,
  productWithIslandedMappingsSchema,
  productWithoutMappingsSchema,
} from "@cubby/schemas/problems";
import type { z } from "zod";
import { type MockOptions, mock } from "~/lib/test/mock-schema";

// Schema-driven fixtures for the Problems page. Each helper generates a
// schema-valid object via `mock()`; pass `overrides` for the fields a test (or a
// Storybook-style preview) actually cares about. The `.fixtures.ts` suffix keeps
// this out of the test glob, and the `mock()` import keeps faker test-only.

type AllProblems = z.infer<typeof allProblemsSchema>;

/** A full `getAllProblems` payload. Arrays default to one item each; override
 * the slices (and `totalProblems`) a test asserts on. */
export const makeAllProblems = (
  overrides?: MockOptions<AllProblems>["overrides"],
): AllProblems => mock(allProblemsSchema, { seed: 1, overrides });

export const makeProductWithoutMappings = (
  overrides?: MockOptions<
    z.infer<typeof productWithoutMappingsSchema>
  >["overrides"],
) => mock(productWithoutMappingsSchema, { overrides });

export const makeIngredientPartialCoverage = (
  overrides?: MockOptions<
    z.infer<typeof ingredientWithPartialCoverageSchema>
  >["overrides"],
) => mock(ingredientWithPartialCoverageSchema, { overrides });

export const makeIslandedProduct = (
  overrides?: MockOptions<
    z.infer<typeof productWithIslandedMappingsSchema>
  >["overrides"],
) => mock(productWithIslandedMappingsSchema, { overrides });
