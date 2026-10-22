import type {
  ExecutedRunPurpose,
  RunStepDeclarationOf,
  RunStepKey,
  StepRunPurpose,
} from "@cubby/schemas/run-fields";

import type { StepCounter, StepDriver } from "./step-run";

type DeclaredInput<P extends StepRunPurpose, K extends RunStepKey<P>> = Extract<
  RunStepDeclarationOf<P>,
  { key: K }
>["input"];

/** Kinds whose `run.execute` Job pages their ledger. */
export type ExecutedStepPurpose = StepRunPurpose & ExecutedRunPurpose;

/**
 * One driver per declared step: a missing or extra key fails typecheck, and a
 * `count` step must supply the COUNT over the predicate its pager walks.
 */
export type StepDriversFor<P extends ExecutedStepPurpose> = {
  [K in RunStepKey<P>]: DeclaredInput<P, K> extends { mode: "count" }
    ? StepDriver & { count: StepCounter }
    : StepDriver;
};

const registry = {
  maintenance: async () =>
    (
      await import("~/server/domains/maintenance/service/maintenance-run")
    ).maintenanceStepDrivers(),
  sweep: async () => (await import("./sweep")).sweepStepDrivers,
} satisfies {
  [P in ExecutedStepPurpose]: () => Promise<StepDriversFor<P>>;
};

/** The `(purpose, stepKey)` drivers of an executed step-ledger kind. */
export async function stepDriversFor(
  purpose: ExecutedStepPurpose,
): Promise<Readonly<Record<string, StepDriver>>> {
  return registry[purpose]();
}
