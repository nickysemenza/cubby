/** Port probes cannot reserve a later bind. Retry only startup address collisions. */
export function shouldRetryRuntime(state: {
  exited: boolean;
  ready: boolean;
  cancelled: boolean;
  logs: string;
  attempt: number;
}): boolean {
  return (
    state.exited &&
    !state.ready &&
    !state.cancelled &&
    state.attempt < 3 &&
    /EADDRINUSE|Port \d+ is already in use/u.test(state.logs)
  );
}
