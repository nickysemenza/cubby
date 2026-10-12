import { holdWorkerdHarness } from "./workerd-harness";

/**
 * The `integration-workerd` project holds this worktree's harness lock for
 * its whole run, like Playwright's global setup: its files then start workerd
 * in parallel (each fork inherits the lock through
 * `CUBBY_HARNESS_LOCK_OWNER`, which forks read at spawn) instead of queueing
 * behind one another, while this worktree's other workerd or browser suite
 * waits. The returned release is Vitest's global teardown.
 */
export default async function setup() {
  return holdWorkerdHarness();
}
