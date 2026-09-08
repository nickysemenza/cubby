export interface TestRunOutcome {
  name: string;
  state: string;
}

/** Require selected test lanes to discover work and execute every discovered test. */
export function assertTestRunContract(
  outcomes: readonly TestRunOutcome[],
): void {
  if (outcomes.length === 0) {
    throw new Error("Selected test lane discovered no tests");
  }

  const unexecuted = outcomes.filter(
    ({ state }) => state === "skipped" || state === "pending",
  );
  if (unexecuted.length > 0) {
    throw new Error(
      `Selected test lane did not execute: ${unexecuted.map(({ name }) => name).join(", ")}`,
    );
  }
}
