# Synthetic browser navigation measurements

This opt-in companion to `read-performance.ts` measures browser readiness rather
than decoded read latency. It reuses the E2E startup profiler and read-harness
percentiles. It starts no services, seeds no data, and creates no permanent
browser state. Use an already running synthetic local instance discovered with
`pnpm dev status --json`; never use a production-volume copy. `synthetic: true`
is the operator's explicit attestation, not automatic verification of the dataset.

Create an ignored `artifacts/navigation-scenario.json` in the checkout. Supply
the actual measured revision, runtime and fixture pack, plus selectors verified
against the current synthetic UI. This example describes a hypothetical synthetic
fixture; its selectors are deliberately illustrative, not a runnable member journey:

```json
{
  "synthetic": true,
  "revision": "abcdef0",
  "runtime": "development",
  "workload": "core",
  "source": {
    "path": "/products",
    "scope": "main [data-synthetic-list]",
    "useful": "[data-synthetic-row]",
    "control": "button[aria-label='Open view options']"
  },
  "target": {
    "path": "/products/synthetic-fixture",
    "scope": "main [data-synthetic-detail]",
    "useful": "[data-synthetic-field]",
    "control": "button[aria-label='Open actions']"
  },
  "link": "a[href='/products/synthetic-fixture']",
  "returnLink": "a[href='/products']",
  "secondary": {
    "path": "/work",
    "scope": "main [data-synthetic-work]",
    "useful": "[data-synthetic-work-row]",
    "control": "button[aria-label='Open view options']"
  }
}
```

`scope` must identify the target's primary content, `useful` a visible populated
field or row within it, and `control` an enabled primary-content control. Do not
select the shell, heading, skeleton, generic router `onRendered` event, or
offscreen enrichment. Route-specific scopes prevent stale source content from
satisfying readiness. Both link selectors must uniquely select same-origin
anchors. SPA samples reject document navigations. The trial click checks hit
testing and actionability without invoking the control. Combined with shell
hydration and two animation frames, this is an observed readiness proxy; it
does not prove that a control's handler or persisted writes work. Validate the
member journey separately with existing coverage.

From the checkout root, with the discovered loopback origin:

```sh
pnpm --dir apps/web exec tsx tooling/checks/navigation-performance.ts \
  --origin http://127.0.0.1:3000 \
  --scenario ../../artifacts/navigation-scenario.json \
  --output ../../artifacts/navigation-before.json \
  --samples 3 --device both --contention
```

Arguments resolve from the `apps/web` working directory selected by `pnpm --dir`.
Only HTTP loopback runtime origins are accepted. Authentication uses the existing
synthetic `/__dev/login` endpoint through a separate API context; session state
stays in memory. The browser uses ordinary caching: interception would disable
HTTP cache. Use local synthetic assets and never point scenario routes at
private data or flows that invoke providers. No screenshots, traces, request
payloads, response bodies, URLs, selector text or credentials enter the report.
Errors omit raw Playwright diagnostics because those can contain DOM data.
The output must live under the checkout's ignored `artifacts/` directory.

Each repetition measures separate contexts for:

- `cold-document`: fresh browser context with empty browser HTTP and query
  caches. This does not reset the browser process, server, database, OS or Vite
  caches. Source-map/dev compilation effects belong in the environment notes.
- `warm-spa`: prime the target, return through its source anchor, then measure
  navigation back to the target while preserving the document and query cache.
- `fresh-spa`: load the source in a fresh context, then measure its target link.
  Source link preloading may still warm target data; inspect the observed
  operation-response counts before describing this as a fresh read.
- `cold-contention`, only with `--contention`: start the supplied secondary page
  immediately before the primary cold navigation, and await both. Primary timing
  ends at primary readiness. This models competing browser navigation, not a
  guaranteed overlap of specific SQL queries. Keep secondary work equivalent
  between comparison arms.

`desktop` and `mobile` are separate result groups. Mobile uses Chromium at
390 × 844 with touch support; it is neither Safari nor real-device evidence and
applies no network/CPU throttling. The default device is desktop. Samples range
from 2 to 30 per group; the default is 3. Repeat with the same scenarios, fixture
pack, sample count, runtime mode and device settings on both revisions. Save
before/after reports separately. Repetitions are paired by index; sequential
before/after runs do not remove machine load or temporal bias. Small-sample p95
is descriptive and often equals the maximum.

`usefulInteractiveMs` includes automation observation overhead. Document timings
and startup resource counts apply only to cold document samples. CPU deltas
overlap wall time and must not be added to network or document timings. Operation
responses are counted only through primary readiness, with no decoding of RPC
results: no observed response does not establish a cache hit, and an HTTP 200
does not establish operation success. HTTP failures observed by readiness are
reported and produce a nonzero exit. Later background failures remain outside
the observation window. Use `read-performance.ts` for decoded-operation failure,
requested-shape, response-byte and database timing evidence.

An optional `--budget-ms 1500` returns a nonzero exit if any measured readiness
sample exceeds that operator-selected threshold. This is a local experiment,
not a universal CI gate. Timeout or scenario failure aborts without updating
the report; an existing output file may therefore describe an earlier run.
No local result establishes production latency or deployed Cloudflare/Hyperdrive
behavior. Record unavailable evidence explicitly alongside any comparison.
