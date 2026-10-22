import { RUN_KINDS } from "@cubby/schemas/run-fields";
import { describe, expect, it } from "vitest";

import { stepDriversFor } from "./run-step-registry";

// `StepDriversFor` already fails typecheck for a missing driver. This guards
// the contract the types cannot see: a step over stored rows must COUNT its
// population (R4); only a declared one-shot or admission step may tally.
describe("Run step registry", () => {
  it("drives every declared executed step and counts each count step", async () => {
    for (const purpose of ["maintenance", "sweep"] as const) {
      const drivers = await stepDriversFor(purpose);
      const steps = RUN_KINDS[purpose].steps;
      expect(Object.keys(drivers).sort()).toEqual(
        steps.map((step) => step.key).sort(),
      );
      expect(
        steps
          .filter((step) => step.input.mode === "count")
          .filter((step) => typeof drivers[step.key]?.count !== "function")
          .map((step) => `${purpose}.${step.key}`),
      ).toEqual([]);
    }
  });
});
