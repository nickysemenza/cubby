# Cloudflare test harness E2E experiment

Status: accepted foundation follow-up; revalidate after stacking on the
known-improvements PR.

This branch replaces the hand-managed `wrangler dev` child process with
Wrangler's `createTestHarness`. It still runs the generated production Worker
configuration, static assets, a fresh IntegreSQL database through local
Hyperdrive, Better Auth setup, queues, and all three Playwright projects. A
shared Playwright fixture supplies the harness's dynamic URL to every test
worker, and a reporter prints the harness timeline and structured Worker logs
when a run fails or retries.

The generated configuration retains its USDA and UPC service bindings. The
existing E2E artifact and filtered install contain only the web Worker, so the
harness overrides those bindings with two minimal, schema-valid local Workers
that return deterministic empty provider responses. This preserves the
production `Fetcher` path without installing auxiliary Worker datasets or
reintroducing the old dead-port fallback noise.

Local validation on macOS:

- `pnpm --filter @cubby/web run build:cf`: passed.
- `pnpm typecheck:web` and `pnpm format:changed`: passed.
- Focused unauthenticated Chromium, authenticated Chromium, and iPhone WebKit
  runs: passed without retries.
- The verified Playwright inventory is 69 tests across 26 files and the
  Unauthenticated, Authenticated, and iPhone WebKit projects.

The initial isolated run had retries in overlapping DnD and Project Tracker
coverage. Stack this branch on the known-improvements foundation, then require
both normal CI shards to pass with the same 69-test inventory and zero retries
before merging.
