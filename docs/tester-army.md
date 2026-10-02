# Tester Army trial

The manual web and iOS lanes exercise the same synthetic product rename and
reopen journey. Agent steps navigate and edit; exact UI and database assertions
decide correctness. Existing deterministic suites remain the merge gate.

## Failure modes and acceptance

Before implementing the runner, the relevant failure modes are: invalid or
missing inference credentials; unsupported image/tool calls; editing the wrong
product; a dismissed editor with an unsaved name; stale client state after
reopening; skipped or missing tests; lost run evidence; leaked credentials in
uploaded reports; and database, Worker, or simulator resources left after failure.

Acceptance requires three consecutive live runs per engine with fresh state and
zero retries, a failing wrong-name assertion, and one local replay comparison.
Model calls, tokens, reported cost, and timings are evidence, not a promise of
equal reliability or savings. The existing deterministic simulator product-edit
journey must also pass after the agent-device upgrade.

## Configuration and commands

Use a Cloudflare API token authorized for inference through Unified Billing.
Set it locally as `TESTER_ARMY_CF_API_TOKEN` or in the repository's Actions
secrets with that name. Local commands also accept `AI_GATEWAY_API_KEY` from the
shell or `apps/web/.env`; set `TESTER_ARMY_ENV_FILE` to use a different `.env`
path in a worktree. Only the inference token is read from that file, so app
database and storage settings do not enter the synthetic harness. The account
defaults to Cubby's configured Cloudflare account; `TESTER_ARMY_CF_ACCOUNT_ID`
overrides it locally or as an Actions repository variable. The gateway defaults to `cubby-testing`; override it with
`TESTER_ARMY_CF_GATEWAY_ID` locally. Do not reuse a deployment token.

The default is `openai/gpt-6-luna` through the Responses API, medium reasoning,
with gateway caching disabled. `TESTER_ARMY_MODEL` explicitly overrides the
model locally or through an Actions repository variable. There is no fallback.
The preflight verifies an image plus a forced function call before builds,
database provisioning, or simulator startup.

```sh
pnpm test:e2e:agent:preflight
pnpm test:e2e:agent:web
pnpm test:e2e:agent:ios
```

The web lane builds the Worker and owns a disposable authenticated database,
object storage, and Worker runtime. The iOS lane reuses the existing simulator
harness, synthetic fixture, local server, native build, and cleanup. Each run
uses fresh fixture state. Install the Chromium browser with
`pnpm --dir apps/web exec playwright install chromium` if needed.
The iOS prerequisites are the same as `pnpm test:e2e:sim`.

Dispatch **CI** manually with `tester_army` set to `web`, `ios`, or `both` and
`simulator_e2e` disabled. These optional jobs do not run on PRs and do not replace
the required checks. Run each engine three times for the live acceptance sample.

Append `-- --wrong-name` to either journey command to deliberately expect a
different name; it must fail the exact assertion. For a local replay comparison,
run the same command twice with `-- --replay`. This enables Tester Army's local
read-write cache; normal runs disable it. Compare the resulting summaries for
model calls, tokens, timings, replay hits and handoffs. Cache eligibility depends
on the engine's observed state, so a warm run may still use the model.

## Evidence

Bundles live under `artifacts/tester-army/web/<run>/` or
`artifacts/sim-tester-army-e2e/<run>/`. They contain `run-manifest.json`,
`run-results.json`, `agent-summary.json` when the engine produced one, and
`SHA256SUMS`. Verify transferred evidence from its run directory with
`shasum -a 256 -c SHA256SUMS`. Manifests record revision, source/build provenance,
replay command, status and phases. Dirty-source runs are not replayable evidence.

`raw/` retains local SDK reports, screenshots, traces and logs for diagnosis.
CI uploads only the sanitized bundle files, with seven-day retention. The
summary includes only fixed synthetic case names and numeric usage/replay
metrics; credentials and fixture identifiers are excluded. Estimated cost may
be absent when the SDK does not report it. Telemetry is disabled.

This trial establishes only the synthetic rename journey on Chromium and an
iOS simulator. It does not establish broader agent reliability or physical
device behavior.
