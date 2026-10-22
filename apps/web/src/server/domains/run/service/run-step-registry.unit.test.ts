import { RUN_KINDS, STEP_RUN_PURPOSES } from "@cubby/schemas/run-fields";
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

  // A tally step's declared reason is type-enforced; an estimate has none,
  // so each one is an explicit exception here.
  it("estimates only populations no single table holds", () => {
    const estimated = STEP_RUN_PURPOSES.flatMap((purpose) =>
      RUN_KINDS[purpose].steps
        .filter((step) => step.input.mode === "estimate")
        .map((step) => `${purpose}.${step.key}`),
    );
    // Search sources span every searchable table.
    expect(estimated).toEqual(["derived_refresh.search"]);
  });
});
