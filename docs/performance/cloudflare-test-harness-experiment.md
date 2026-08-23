# Cloudflare test harness E2E experiment

Status: viable draft, not accepted.

This branch replaces the hand-managed `wrangler dev` child process with
Wrangler's `createTestHarness`. It still runs the generated production Worker
configuration, static assets, a fresh IntegreSQL database through local
Hyperdrive, Better Auth setup, queues, and all three Playwright projects. A
shared Playwright fixture supplies the harness's dynamic URL to every test
worker, and a reporter prints the harness timeline and structured Worker logs
when a run fails or retries.

The generated configuration contains USDA and UPC service bindings, but the
existing E2E artifact and filtered install contain only the web Worker. Unlike
`wrangler dev`, `createTestHarness` refuses to start when those target Workers
are absent. The experiment therefore removes those two bindings from its
generated E2E config and retains the existing hermetic URL fallbacks, including
the dead local USDA endpoint. This must be accepted as behavioral parity before
the experiment can merge; running or building the auxiliary Workers would add
new setup work and is outside this isolated trial.

Local validation on macOS:

- `pnpm --filter @cubby/web run build:cf`: passed.
- `pnpm typecheck:web` and `pnpm format:changed`: passed.
- Focused unauthenticated Chromium, authenticated Chromium, and iPhone WebKit
  runs: passed without retries.
- Full unsharded CI-mode inventory: 66 passed with three retries in 4.4 minutes.
- Exact CI-mode shard `1/2`: 33 passed with two retries in 1.5 minutes. Both
  retries were in the drag-and-drop file; one included an unexpected sign-in
  redirect.

The local retries mean this branch has not met the zero-new-retries acceptance
rule. Evaluate it only as a draft after rebasing onto the known-improvements
foundation, then compare normal two-shard CI against the representative run
history. Keep it only if project/test inventory is identical, retries do not
increase, and E2E duration is no slower.
