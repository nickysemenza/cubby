import { holdWorkerdHarness } from "./workerd-harness";

/**
 * The `integration-workerd` project holds the machine-wide harness lock for
 * its whole run, like Playwright's global setup: its files then start workerd
 * in parallel (each fork inherits the lock through
 * `CUBBY_HARNESS_LOCK_OWNER`, which forks read at spawn) instead of queueing
 * behind one another, while another worktree's workerd or browser suite still
 * waits. The returned release is Vitest's global teardown.
 */
export default async function setup() {
  return holdWorkerdHarness();
}
