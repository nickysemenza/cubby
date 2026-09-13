export interface TestRunOutcome {
  name: string;
  state: string;
}

/**
 * Require selected test lanes to discover work and execute every discovered
 * test. `allowEmpty` is for `vitest --changed`, where "no test imports the
 * changed files" is a legitimate outcome rather than a misconfigured lane.
 */
export function assertTestRunContract(
  outcomes: readonly TestRunOutcome[],
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): void {
  if (outcomes.length === 0 && !allowEmpty) {
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
