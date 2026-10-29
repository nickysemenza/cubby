# Web Tester Army journeys

The optional web suite exercises user goals through Tester Army's Chromium
engine. Jev selects actions and targets; a small companion text model supplies
field values. The supported executor requires that companion for typing. The
configured model and budgets live in
[`model.ts`](../apps/web/tooling/tester-army/model.ts) and
[`e2e.config.ts`](../apps/web/e2e.config.ts), following the upstream
[decision executor](https://e2e.tester.army/docs/decision-models).
There is one gateway route per model, without funding fallbacks.

## Runtime and outcomes

Every journey uses the shared `withSeededE2ERuntime` fixture over
`createE2EWorkerRuntime`: its own IntegreSQL database lease, authentication,
Worker, bindings and local object storage, all released after that journey.
The template and built Worker are reused; Nx's `build-cf` prepares the Worker
before the suite starts. Ordinary journeys use the `offline`
profile; import journeys use `coupled` for real background/telemetry consumers
and scripted external peers. The same fixture support is available to
Playwright; Tester Army adds the browser goals, not a separate application
bootstrap. Cloudflare's
[test harness](https://developers.cloudflare.com/workers/testing/test-harness/)
owns Worker execution. Both browser fixtures share Sentry disabling, the
authenticated-shell readiness marker, stale keep-alive retries and the same
derived-refresh pump in every profile. The local harness runs queues but not
the scheduled dispatcher that wakes derived Jobs; the pump uses the production
paged frontier so public projections settle in both browser suites.

Starting entities live in the synthetic `tooling/scenarios/web-journeys.ts`
scenario, seeded through the existing kernel fixture helpers. Journeys read
named identities from that world instead of creating their own setup records.
Import scenarios seed source evidence; production processing creates outcomes.
Each journey gets an independent copy, so edits, deletion and split cases do
not depend on suite order.

Only the browser driver's inference is live. App-side descriptions and import
coordinator judgments are scripted at the provider seam. Actual uploads,
description Jobs, grouping tools, review commands, persistence and Run
completion execute production code. Photo grouping starts automatically; the
retired journey's Start grouping instruction is obsolete. These tests establish
application behavior, not live extraction or vision quality.

A synthetic public image origin is routed through Cloudflare's Node outbound
fetch proxy and the browser to the existing local R2 delivery adapter. This
keeps the production external-URL guard intact. The JPEG fixtures already fit
the rendition bounds; this suite exercises processing of their stored bytes,
not Cloudflare's edge resizing implementation.

Journeys use natural-language goals with fixed checks of public API outcomes
and consequential visible results. The agent's completion verdict never
establishes a pass. Stable confirmation buttons use SDK locators where needed;
completion is established by the dialog closing and independent read-back,
not by asking the model to judge a write. The simple finding dismissal uses
SDK actions directly. Exact-value relationship pickers also use SDK actions:
captured failures showed correct drafts followed by targetless model taps or
contradictory completion judgments. Draft values, save and persisted assignments
remain independently asserted. These are ordinary framework actions, not a custom
replay driver or a second assertion system. Checks cover money, ownership/identity, unrelated data and
forbidden writes before confirmation. Public read helpers understand both
ordinary fields and governed field envelopes. They do not query retired storage
tables. Every outcome check also rejects a corrupted expected value.

The one private read-back is accepted-source actor attribution: it uses the
current typed `AssessmentEmailLink` projection through the same guarded
disposable database lease and closes its pool. Public Email and retained-source
reads independently bind the accepted source checksum to the imported Purchase.

## Running and evidence

Run from the repository root:

```sh
pnpm --filter @cubby/web test:e2e:agent:web
pnpm --filter @cubby/web test:e2e:agent:web --grep 'wardrobe upload'
TESTER_ARMY_FRESH=1 pnpm --filter @cubby/web test:e2e:agent:web
CUBBY_TESTER_ARMY_SHARD=1/3 pnpm --filter @cubby/web test:e2e:agent:web
```

The shared test-service manager prepares PostgreSQL and IntegreSQL. The normal
build ensure verifies the Worker before startup. Local credentials use the
existing `localSecret` lookup for `TESTER_ARMY_CF_API_TOKEN` or
`AI_GATEWAY_API_KEY`; only that key is loaded, never household database settings.
Missing credentials are incomplete setup, not a passing or silently skipped
test. The gateway’s TypeSafe BYOK organization also needs available Jev credits;
HTTP 402 is a provider failure. The SDK reports every upstream failure as
`MODEL_PROVIDER_FAILED`, so the runner appends each non-OK Jev or text-companion
response to `provider-errors.jsonl` (HTTP status, `cf-ray`, body with the
gateway token and credential headers scrubbed, mode 0600) and never substitutes
another model. The summary names the status; the HTML report links the record.

Two caches have different meanings:

- Nx's `@cubby/web:tester-army` target can replay a whole successful result for
  identical source, toolchain and execution inputs, including the shard selector. This is evidence from the
  original run, not fresh agent execution. Failed/incomplete runs do not publish
  a passing cache result.
- Tester Army's local action replay can reuse navigation while still executing
  the journey and its outcome checks. Its ignored `.e2e/cache` is not uploaded
  or maintained as a separate shared cache.

The direct command bypasses whole-suite Nx results. `TESTER_ARMY_FRESH=1` also
disables action replay. Tester Army runs only on demand locally; CI does not
start journeys, consume model credentials for them, or collect their reports.
Local sharding remains available through `CUBBY_TESTER_ARMY_SHARD`; each shard
has a separate Nx result key.

`apps/web/artifacts/tester-army/` holds the SDK JSON, JUnit, step traces,
sanitized Worker logs, setup/scenario timings and a static HTML report. Every
journey records video and an end-state screenshot; setup failures may have only
startup diagnostics. A passing journey, or one that failed inside its body,
without a nonempty screenshot and video inside `run/results/` is incomplete:
the shard exits nonzero (so Nx caches nothing), the combined report is not
complete, and broken or traversing artifact paths are listed instead of linked. Videos are retained for successful flows too. Session
cookies stay inside each fixture's browser and API contexts, never in an
interchange file. The gateway token is registered as an SDK secret.

Local reports stay local. CI's `Test report` job publishes only Vitest and
Playwright evidence and does not wait for Tester Army.

Failure summaries classify startup/fixture, provider, agent and application/
outcome boundaries without claiming an automatic root-cause diagnosis. Per-case
HTML shows steps, media, cache decisions and links to Worker diagnostics. Missing
shard/timing evidence is unknown, never a passing zero. Runner lock/build/template
preparation and each fixture's startup/authentication/seeding are measured
separately from journey execution.

The pinned decision executor has a one-line dependency patch reserving the
`none` target slot inside TypeSafe's 255-choice limit. Upstream 0.3.0 otherwise
constructs 256 choices on dense Run pages. Remove the patch when an upstream
release reserves that slot; the real wardrobe journey exercises this boundary.

For the negative acceptance probe, run the product-rename journey with
`TESTER_ARMY_WRONG=1` and verify the failure occurs at its persisted-outcome
assertion, after the action succeeds. An arbitrary nonzero startup/provider
failure does not satisfy that probe.

## Retired coverage accounting

The catalog is recovered by outcome, not by restoring driver workarounds or
every former test verbatim. Existing deterministic tests remain intact.

| Retired web journey                                             | Current owner and retained outcome                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `product-rename`                                                | `catalog.e2e.ts`: saved rename, reopen and preserved notes                                                          |
| `hero-set-status`, `hero-mark-purchased`                        | `catalog.e2e.ts`: persisted project status and acquired Wish                                                        |
| `hero-delete-task`                                              | `catalog.e2e.ts`: no preview write; child deletion and project preservation                                         |
| `field-product-tags`                                            | `catalog.e2e.ts`: added tag preserves existing tags; order is incidental                                            |
| `field-source-alias`, `field-external-ids`, `field-source-refs` | `catalog.e2e.ts`: structured identifiers persist without changing identity or amount                                |
| `field-label-nutrition`, `field-recipe-line`                    | `catalog.e2e.ts`: selected edit preserves other nutrition/instructions                                              |
| `record-picker-desktop`, `record-picker-phone`                  | `relationships.e2e.ts`: named project selection at both viewports, vendor preserved                                 |
| `board-move-card`                                               | `relationships.e2e.ts`: task moves projects; sibling remains unchanged                                              |
| `field-source-claim`                                            | `relationships.e2e.ts`: description changes, canonical source key/count and money preserved                         |
| `receive-purchase`, `hero-add-inventory`                        | `stock-finance.e2e.ts`: received and additional stock preserve existing units and purchase money                    |
| `hero-record-sale`                                              | `stock-finance.e2e.ts`: signed sale amount and product preservation                                                 |
| `finance-split-expense`, `finance-split-unknown-cost`           | `stock-finance.e2e.ts`: mismatch/missing-cost refusal and per-part cent conservation                                |
| `finance-attach-expenses`, `finance-attach-products`            | `stock-finance.e2e.ts`: move requires confirmation; product association preserves expense money                     |
| `email-navigation`                                              | `imports.e2e.ts`: metadata navigation preserves classification/admission                                            |
| `run-console`                                                   | `imports.e2e.ts`: visible Run progress and persisted finding dismissal through Problems                             |
| `import-order-mail`                                             | `imports.e2e.ts`: real import from saved evidence; date, product URL and amount retained; shipping Email unadmitted |
| `import-photo-inventory`                                        | `imports.e2e.ts`: real image-processing/grouping Jobs, individual and batch approval, photo attachments and stock   |

The retired `collection:` tag convention is now an ordinary tag; named groups
use saved views. Native driver behavior, visual baselines, exploration and live
app-side model evaluations are deliberately outside this suite. Exact old
storage-row identifiers and the former mail-only account status are not public
outcome contracts; canonical identity and source admission are checked instead.

## Replacing other tests later

This recovery deletes no existing tests and establishes no blanket equivalence
to unit or integration coverage. Before removing a consequential regression,
name its retained journey, restore the relevant fault and show that the journey
rejects it, and collect fresh execution evidence without retries or either
cache. The [validation retention policy](agents/validation.md#test-retention)
continues to govern each deletion. Missing coverage and delivery work belongs
to [issue #3421](https://github.com/nickysemenza/cubby/issues/3421).
