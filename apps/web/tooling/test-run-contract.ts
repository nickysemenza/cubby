export interface TestRunOutcome {
  name: string;
  state: string;
  /** `-t` left this test out of the selection, so its skip is expected. */
  deselected?: boolean;
}

/**
 * Require selected test lanes to discover work and execute every selected
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

  const selected = outcomes.filter(({ deselected }) => !deselected);
  if (selected.length === 0 && outcomes.length > 0) {
    throw new Error("Selected test lane matched no tests");
  }

  const unexecuted = selected.filter(
    ({ state }) => state === "skipped" || state === "pending",
  );
  if (unexecuted.length > 0) {
    throw new Error(
      `Selected test lane did not execute: ${unexecuted.map(({ name }) => name).join(", ")}`,
    );
  }
}
