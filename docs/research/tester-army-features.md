# Tester Army e2e: feature catalog for Cubby

Question: what does the current e2e framework offer, and which features would
help Cubby's trial (`docs/tester-army.md`)?

Recommendation: keep browsers and simulators local; exclude paid hosted
infrastructure. Prioritize a Jev decision-executor trial alongside verified
replay, shared web/iOS flows, visual coverage (after an upgrade), and bounded
exploration. Keep the deterministic merge gate
until matched-coverage measurements justify changing it. A full runner migration
has no demonstrated CI speed advantage.

Sources: official docs only. All 56 pages listed in
<https://e2e.tester.army/docs/llms.txt> were fetched as Markdown on 2026-10-09.
Package versions came from the npm registry the same day, including
[e2e](https://registry.npmjs.org/e2e/latest),
[web](https://registry.npmjs.org/%40e2e-dev%2Fweb/latest),
[mobile](https://registry.npmjs.org/%40e2e-dev%2Fmobile/latest), and
[decision](https://registry.npmjs.org/%40e2e-dev%2Fdecision/latest). Cubby's usage comes
from `apps/web/e2e.config.ts`, `apps/web/tooling/tester-army/*.ts`,
`apps/web/tests/tester-army/*.e2e.ts`, and the docs bundled with the pinned
package (`apps/web/node_modules/e2e/docs`). No household data or credentials were
used. Existing public CI job timings were inspected; no new live test runs
were performed.

How to read this note:

- **Confirmed** means an official page says it. Each group links its page.
- **Inference** or **Recommendation** is this note's own judgment and is
  labelled that way.
- The final CI section compares current Cubby configuration and two existing
  green runs; the feature matrix summarizes the broader catalog.

## Upgrade follow-up

The implementation following this assessment upgrades e2e/web/mobile to
0.19.0/0.14.0/0.11.0, ports the native driver patch to 0.21.22, and adds
the Jev decision executor using Cloudflare Workers AI through gateway `cubby`.
The matrix below preserves the pre-upgrade snapshot; current usage and
validation commands are owned by [Tester Army](../tester-army.md).
The live decision and text preflight passed. Initial exploratory runs exposed
web hydration/picker accessibility and native structured-field keyboard failures.
After the web fixes, Jev passed rename with editor reopen, external IDs, source
references and inventory addition, with exact database read-back. The current [validation results](../tester-army.md#upgrade-validation-2026-10-09)
record the default-Jev implementation and keep the deterministic merge gate in place. No speed or total
cost saving has been established.

## Version gap (confirmed)

| Package                                                | Cubby pins    | npm `latest` (2026-10-09)         |
| ------------------------------------------------------ | ------------- | --------------------------------- |
| `e2e`                                                  | 0.16.0        | 0.19.0                            |
| `@e2e-dev/web`                                         | 0.11.2        | 0.14.0                            |
| `@e2e-dev/mobile`                                      | 0.9.1         | 0.11.0                            |
| `@e2e-dev/kernel`, `eas`, `smol`, `decision`, `github` | not installed | 0.2.1, 0.3.1, 0.1.0, 0.2.0, 0.4.0 |

The live site documents 0.19-era behavior. The docs bundled with 0.16.0 have
no page for visual comparison, decision models, smol, `e2e/runner`, the
security-rules reference, or example projects. Its Playwright migration table
lists `toHaveScreenshot()` as "not yet". Existing capabilities were checked
against the pinned package where relevant
(for example strict replay is present). New integrations and screenshot features
need a compatibility check before use. The current decision executor 0.2.0
requires `e2e >=0.19.0` and `ai ^7.0.134`; current web engine 0.14.0 requires
`e2e >=0.18.0`. Current mobile 0.11.0 pins agent-device 0.21.22, so review
Cubby's override/patch behavior before upgrading it. The bundled
`node_modules/e2e/docs/*.mdx`
show what 0.16.0 actually ships.

## Cubby's current usage (from the repo)

Cubby already uses these features: `web()` with Chromium at 1440×1000 and
`browser.setViewport` per journey; `mobile({ platform: 'ios', device, session })`;
`agent.act` with `params` and `unique()`; `agent.extract` with a Zod schema;
`expect` with `screen.getByText`; `app.open`; `browser.setCookies`;
`device.openLink`; one `default` agent with `context`, `maxSteps: 40`,
`maxModelCalls: 40`, and `providerOptions`; ChatGPT OAuth
(`e2e/oauth/chatgpt`) or the gateway; `secrets`, which register session-cookie
values and the inference token; the `list` and `junit` reporters plus a custom
`Reporter`; `cache` set to `off`, or `read-write` under `--replay`; telemetry
off; `workers: 1`; `retries: 0`.

Cubby doesn't use these: `test.setup` sessions, `credentials`, `agent.assert`,
`agent.waitFor`, `judge`, named agents or personas, project tools, custom
executors, `e2e explore`, bug bashes, `e2e mcp`, visual comparison, the
`browser.route` mocks, `artifacts.store`, `video`/`trace` config, hosted
providers, or the API-test pattern.

## Feature matrix

Legend for "Cubby fit": **Use** = clear fit now; **Try** = worth a bounded
trial; **Skip** = no fit or ruled out; **Keep** = retain the existing capability.

| Group                  | Doc-confirmed capability (short)                                                                                                                   | Cubby fit                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Core test model        | `act`, `assert`, `waitFor`, `extract`, `screen` locators, `expect`; tags, `serial`, hooks, `test.extend`, `test.skip`                              | In use                                   |
| API testing            | `fetch` with value matchers, `toMatchSchema`, `expect.poll`; a target with no engine                                                               | Try                                      |
| Hybrid deterministic   | Locator steps make no model call; `expect` after `act` makes the step eligible for the cache                                                       | In use                                   |
| Visual comparison      | `toHaveScreenshot` (screen or element) with masks and tolerance; per-target/OS PNGs; `--update-snapshots`                                          | Try (needs upgrade)                      |
| Explore                | `e2e explore "<goal>"`: severity-ranked findings with repro steps; an issue exits 1                                                                | Try                                      |
| Bug bash               | A skill-driven fan-out of 5–10 explore charters (4 at once), each proved by a failing repro tagged `bugbash`                                       | Try (later)                              |
| Agents and personas    | Named agents; `system` vs `context` split; `agentContext`; pin by call, test, or group; `--agent a,b`                                              | Use                                      |
| Coding-agent skill     | `e2e init` / `skills add tester-army/e2e`; `create-verification-skill`; offline `.mdx` docs                                                        | Try                                      |
| MCP server             | `e2e mcp`: up to 16 sessions; `locate` returns test code; recordings                                                                               | Try                                      |
| Authentication         | `test.setup` + `session.save`; `credentials`; `Secret` handles; vault functions; `E2E_SECRET_*`                                                    | Try                                      |
| Models                 | Any AI SDK provider with tool calls; gateway, OpenRouter, direct, OpenAI-compatible; separate `judge`                                              | Use (`judge`)                            |
| Subscriptions          | ChatGPT, Copilot, OpenCode, SuperGrok logins; Claude Max/Team through API credits                                                                  | In use                                   |
| Decision models        | `@e2e-dev/decision`: Jev or `gpt-6-luna` decision model plus a small text model; confidence gates                                                  | Priority pilot: Jev + small text model   |
| Caching                | Records verified `act` steps; read-only in CI; `--strict-cache`; custom `cache.store`                                                              | Use (bounded replay pilot)               |
| CI and PR comments     | GitHub Actions, EAS, Bitrise, Codemagic; sharding; `--max-failures`; `@e2e-dev/github`                                                             | Keep Actions; try sanitized PR summaries |
| Kernel                 | Hosted Chromium; worker or attempt scope; replay video; downloads                                                                                  | Skip: free credit then metered usage     |
| EAS Simulators         | Hosted iOS/Android through agent-device; Expo project; 40-minute session cap                                                                       | Skip: no verified free allowance         |
| smol                   | Local Chromium microVMs; copy-on-write branch per attempt; optional app-in-VM                                                                      | Try (maybe)                              |
| Project tools          | `defineTool` with `mutates`/`platforms`; `getToolContext().observe`; `mobileTools`                                                                 | Try                                      |
| Custom executors       | `createToolLoopExecutor` or a `StepExecutor`; `surfaceOf` for direct Playwright                                                                    | Skip for now                             |
| Writing an engine      | The `e2e/engine` contract (`defineEngine`, capabilities, lifecycle, fixtures)                                                                      | Skip                                     |
| Browser escape hatches | `route`, `waitForResponse`, `onDialog`, `waitForDownload`, `frameLocator`, `evaluate`, init scripts, cookies, other browsers, `connect`, providers | Try (selective)                          |
| Mobile                 | Simulator, emulator, or phone; the `device` fixture; launch args; known limitations                                                                | In use                                   |
| Security               | Secret handles; screenshots off after a secret fill; redaction gaps; no origin allowlist                                                           | Use (constraints)                        |
| Telemetry              | PostHog EU on by default; opt-outs; `E2E_TELEMETRY_DEBUG`                                                                                          | In use (off)                             |
| Debugging              | `trace.md` per failure; `report.json`; `--debug`; `--ai-trace`; video modes                                                                        | Use                                      |
| Reporters              | `onEvent` / `onRunFinished`; `renderMarkdownReport`; `artifacts.store`                                                                             | In use                                   |
| `e2e/runner`           | `list()` collects and selects with no run                                                                                                          | Try                                      |
| Migrations             | Guides for Playwright, Cypress, Selenium, Detox, Maestro; Playwright can run alongside                                                             | Info                                     |
| Reference              | test, expect, screen, app, agent, config, CLI, MCP, reporters, env, errors, security rules, web, mobile, engine                                    | Info                                     |

## Findings by group

### Core concepts and hybrid tests

[Core concepts](https://e2e.tester.army/docs/core-concepts) ·
[How agent steps work](https://e2e.tester.army/docs/agent-steps) ·
[agent reference](https://e2e.tester.army/docs/reference/agent)

Confirmed:

- There are three step kinds. `act` calls the model unless the cache replays
  it. `assert`, `waitFor`, and `extract` always call it. Locator steps never
  do.
- A judge sees only the statement, the current screen, and `context`. It
  doesn't see earlier steps.
- Budgets: `act` and `waitFor` default to 25 model calls; `act` also gets 25
  actions. `assert` and `extract` get 2 calls each. Judgments default to a
  30 s timeout.
- `waitFor` makes no model call while the screen stays unchanged.
- A verdict is `passed`, `failed`, or `blocked`. Blocked codes set the exit
  code: auth and seed errors exit 2, an unavailable environment exits 3, and
  budget or unsupported-action errors exit 1.
- `vision: true` or `'only'` adds a masked screenshot. Without it, judgments
  read the redacted text tree.
- `unique()` marks a per-run value so a recording still replays. Use it for
  values the flow types or looks for, not for choices that steer the flow.

Inference: Cubby's split (agent navigates; exact text and SQL read-backs
decide) is the documented hybrid pattern. `agent.waitFor` could supplement checks of UI-visible states when an exact
locator cannot express them. Keep deterministic `ready`/`awaitRun` and SQL
checks for lifecycle and persisted state: a screen judgment cannot establish
those contracts and adds model dependency.

### API testing

[API](https://e2e.tester.army/docs/api-testing)

Confirmed: an API test in the same file and run needs only `app` and no
model. `toMatchSchema` accepts any Standard Schema, including Zod, and returns
the value typed. `app.baseUrl` follows a port-0 allocation. A signed-in
request needs a `test.extend` fixture that forwards `browser.cookies()`. A
target with no engine opens no browser, but it also has no `app.baseUrl`.

Recommendation: this could check the coupled-import HTTP steps, such as the
photo-run create/stage/PUT/finalize flow, using Cubby's own Zod contracts. It
doesn't replace the existing integration tests; the AGENTS.md test-tier rules
still decide that.

### Visual comparison

[Visual comparison](https://e2e.tester.army/docs/visual-testing)

Confirmed: `expect(screen|locator).toHaveScreenshot(name, opts)` stores one
PNG per target and OS under `<test>.e2e.ts-snapshots/`. The first run writes
the PNG and fails. In CI the matcher never writes into the project; a missing
image goes into the results instead. Defaults are `threshold` 0.2,
`maxDiffPixels` 0, and `maxDiffPixelRatio` 0, with locator `mask`. Animations
and the caret are frozen on the web, and the status bar is pinned on devices.
After a secret fill the matcher fails with `POLICY_DENIED`.

Gap: 0.16.0 doesn't have it.

Inference: Cubby's synthetic seed varies per run, with shortcodes and dates,
so screenshots would need masks or a fixed seed. Baselines must come from
the CI runner OS. It's a candidate for a few stable layouts at phone width,
not for journeys.

### Exploration and bug bashes

[Exploring without a test](https://e2e.tester.army/docs/explore) ·
[Bug bashes](https://e2e.tester.army/docs/bug-bash)

Confirmed:

- Explore defaults to 8 steps and 10 minutes, with a maximum of 12 steps and
  15 minutes. It accepts `--session`, `--target`, `--agent`, and `--output`.
- An `issue` finding exits 1 and a `warning` does not. Findings include repro
  steps and a screenshot.
- Explore and MCP sessions don't use the replay cache.
- Bug bash comes from the e2e skill. It reads routes and the branch diff,
  writes 5–10 charters with fixed postures, and runs 4 explores at once. It
  then rejects findings with a known cause and writes a repro per finding. A
  finding counts as a bug only if its repro fails with `ASSERTION_FAILED`.
  Repros are tagged `bugbash`, and the gating run excludes them with
  `--exclude-tag bugbash`.
- The app must serve concurrent explorers (port 0 or `reuseExisting`), and
  each mobile explorer needs its own device.

Inference: explore needs a signed-in start. The docs' route is a `test.setup`
session, but Cubby signs in by injecting cookies at config load, so explore
would need a setup test or an adapter. Explore leaves no database read-back,
so its findings are leads, not verdicts. That matches the docs' own "compare
each finding with its evidence". Model cost scales with charters × steps.

### Agents, personas, models, and subscriptions

[Agents and personas](https://e2e.tester.army/docs/agents) ·
[Models](https://e2e.tester.army/docs/models) ·
[Subscriptions](https://e2e.tester.army/docs/subscriptions)

Confirmed:

- `system` reaches only the act loop. `context` (16 KiB maximum) and
  per-test `agentContext` reach every call, judges included.
- Agents don't inherit from each other.
- Cache entries are keyed by agent name and context.
- `judge` sets a separate judging model, and reports name the judge for each
  step.
- There is no default model. A missing key fails with `MODEL_PROVIDER_FAILED`.
  Some providers fail at config load instead, with `CONFIG_LOAD_FAILED`.
- OpenAI Responses calls send `store: false` with a prompt-cache key. A
  gateway combined with `store: true` can fail with an `rs_…` not-found
  error.
- Every request carries e2e identification headers.
- `E2E_OAUTH_CREDENTIALS` never saves refreshed tokens. The docs advise API
  keys in CI. This matches Cubby's documented `LOGIN_REQUIRED` rotation
  problem.

Recommendations:

1. Keep factual app behavior such as "Save closes the editor" in `context`.
   Put actor instructions such as "Use only the synthetic records named in
   each goal" in `system`. The documented split is useful; the existing
   context is not evidence of a wrong verdict.
2. Keep fresh names/identifiers in `unique()` params where possible. Moving
   them to `agentContext` would re-key replay entries on each fresh fixture.
3. Try a separate `judge` for `extract`, retaining exact seeded comparisons.

### Decision models

[Decision models](https://e2e.tester.army/docs/decision-models) ·
[Custom executors](https://e2e.tester.army/docs/executors)

Confirmed: `decisionExecutor({ model, textModel, vision, minProbability, minConfidence })`
runs `act` and `assert`. The decision model picks an operation and then an
element from a closed list. The text model writes typed values, and
`waitFor`/`extract` also go through it. There is no `navigate` or
`scrollUntil`, and a multi-select listbox isn't supported. Each question is
capped at 255 options. With `vision`, a point tap costs 4 decision calls plus
1 text call. Vision through the Vercel gateway is rejected, and a text-only
Jev refuses images. Gates are off by default. An entry with a custom
`executor` rejects `system` and `tools`.

Gap: 0.16.0 doesn't have it.

Inference: Cubby's production already calls Jev, so this is a plausible
experiment after an SDK/dependency compatibility check, but only on simple non-coupled journeys. Dense forms that exceed
255 nodes may need scrolling. Treat it as an evaluation, not a replacement.

### Coding agents and MCP

[Coding agents](https://e2e.tester.army/docs/coding-agents) ·
[MCP server](https://e2e.tester.army/docs/reference/mcp)

Confirmed:

- `e2e init` installs `.agents/skills/e2e/` (with a `.claude/skills/e2e`
  symlink) and registers `.mcp.json`. `e2e guide [topic]` prints the skill.
- `create-verification-skill` generates `verify-<app>` with a feature map and
  one explore charter per feature.
- `e2e mcp` needs no model. It allows 1–16 sessions (4 by default), each its
  own browser or device. `locate` returns the `screen.*` call when exactly one
  node matches.
- After a secret fill, `screenshot` and the point tools answer `PIXEL_TAINTED`.
- An MCP session closes after 30 minutes idle or 4 hours total. It records
  nothing to the cache or test results.
- Sessions on one config share a secrets registry. A different config fails
  with `CONFIG_IN_USE`. A package-created engine shared by two sessions fails
  with `ENGINE_IN_USE`.

Inference: Cubby's config reads `TESTER_ARMY_TARGET`, `TESTER_ARMY_ORIGIN`,
and cookies from the environment at load. MCP would need the harness's seeded
Worker and those variables. That fits a wrapper script better than the stock
`.mcp.json`. Skill installation adds repo files, so it's an AGENTS.md/skill
routing decision.

### Authentication and secrets

[Signing in](https://e2e.tester.army/docs/authentication) ·
[Security](https://e2e.tester.army/docs/security) ·
[Security rules](https://e2e.tester.army/docs/reference/security)

Confirmed:

- A `test.setup` with `sessions: [...]` runs before dependents. A failed
  setup skips its dependents (`setup-failed`).
- A session holds cookies, local storage, and IndexedDB. It is encrypted with
  a run-only key and never reused.
- `session.save()` doesn't verify sign-in; assert before saving.
- A `Secret` has no `.value`. A secret fill turns off screenshots for the
  attempt and for sessions restored from it.
- A cookie set with `browser.setCookies` keeps screenshots on. Its value is
  redacted only if it's a configured secret.
- Redaction misses transformed, encoded, or split values, video, binary
  downloads, and `command.log`.
- There is no origin allowlist.
- Cache entries are unsigned and store typed values verbatim, except secrets.
- `basicAuth` answers a 401 from any origin. `headers` apply site-wide,
  including shared suffixes such as `vercel.app`.

Inference: Cubby's cookie-as-secret approach is the documented way to keep
screenshots and `vision`. Moving to a password-fill setup would disable
pixels for every journey, so keep the cookies. Recordings and committed cache
entries need review before sharing.

### Hosted integrations

[Hosted browsers and devices](https://e2e.tester.army/docs/integrations/index) ·
[Kernel](https://e2e.tester.army/docs/integrations/kernel) ·
[EAS Simulators](https://e2e.tester.army/docs/integrations/eas) ·
[smol](https://e2e.tester.army/docs/integrations/smol) ·
[Working with the browser](https://e2e.tester.army/docs/browser#hosted-browsers)

Confirmed:

- **Kernel** needs `KERNEL_API_KEY`. It runs one browser per worker, or per
  attempt. Attempt scope loses `headers`, `basicAuth`, `locale`,
  `clearState`, and sessions. It deletes tagged browsers at run end (600 s
  idle backstop), records a 10 fps replay, and serves downloads.
- **EAS** requires an Expo project id, `EXPO_TOKEN` or an eas-cli login, and
  limited access. A session takes about 3 minutes to start and lasts at most
  40 minutes (115 on a high-priority plan). Use `videoTouches: false`.
- **smol** needs Apple Silicon macOS or Linux with KVM, and no account. A
  copy-on-write branch per attempt starts in about 1 s. `prepare(cdp)`
  replaces sessions. The VM has unrestricted network access and reaches every
  host loopback port. App-in-VM copies `/app` and resets a database inside that VM per
  attempt; an external database stays shared. Worker scope leaves stopped machines behind if killed.
- A custom `BrowserProvider` or `DeviceProvider` is a few dozen lines. Their
  methods are `acquire`, `release`, `record`, `downloads`, and `sweep`.

Inference: Kernel needs connectivity to Cubby's local disposable Worker,
so its immediate payoff is limited. EAS can install an independently built
SwiftUI simulator app; it is not restricted to Expo-built apps, although it
requires an Expo project and access. A future pilot must solve backend
connectivity, upload/build provenance and compatibility with Cubby's patched
agent-device. smol is attractive for browser isolation, but it does not reset
our external Postgres state; preserving data isolation needs additional
harness work. None currently establishes a CI speed saving.

### Project tools, custom executors, and engines

[Project tools](https://e2e.tester.army/docs/tools) ·
[Custom executors](https://e2e.tester.army/docs/executors) ·
[Writing an engine](https://e2e.tester.army/docs/writing-an-engine) ·
[e2e/engine](https://e2e.tester.army/docs/reference/engine)

Confirmed:

- `defineTool(tool, { mutates, platforms })` registers a project tool. A
  mutating tool takes an action slot and always runs live on replay.
- `getToolContext().observe/attachScreenshot` is available from read-only
  tools.
- Reserved names fail config load with `INVALID_CONFIG`.
- `mobileTools` adds `open_app`, `swipe`, and `alert`.
- Executors get redacted observations and checked `ctx.actions`. Their
  `cache` mode is `inherit` or `off`.
- `surfaceOf(engine).page()` gives direct Playwright access but bypasses
  authorization and the cache.
- Engines go through `defineEngine`. The runner owns polling and policy; the
  engine owns UI mechanics.

Recommendation: a read-only tool could let the agent query seeded state. A
mutating tool could reach a synthetic-only test API. Neither should replace
the SQL read-backs that decide pass or fail. Executors and engines don't fit
Cubby now.

### Browser escape hatches and web engine

[Working with the browser](https://e2e.tester.army/docs/browser) ·
[Web](https://e2e.tester.army/docs/web) ·
[Browser reference](https://e2e.tester.army/docs/reference/web)

Confirmed:

- `browser.route` mocking survives a restart.
- `waitForResponse`, `onDialog` (an unhandled dialog fails the next step),
  `waitForDownload` (saved as an artifact), and `frameLocator` are available.
- `evaluate` must be serializable.
- Init scripts can be set for the whole engine or per test.
- `setCookies` accepts only `http`/`https` URLs.
- Firefox and WebKit run as extra targets. `connect` attaches over CDP.
- `inert` content is hidden from the agent. Open and closed shadow roots are
  reachable.
- Viewport-only phone targets aren't touch, color-scheme, or reduced-motion
  emulation.
- `app.command` with port 0 and `readyUrl` is supported. There is no services
  API yet.

Recommendation: a WebKit phone-width target is a cheap second browser.
`onDialog` deserves a look if any journey hits `confirm()`. Treat
`browser.route` mocks with care: Cubby prefers real Workers behind the
browser.

### Mobile

[Mobile](https://e2e.tester.army/docs/mobile) ·
[Mobile reference](https://e2e.tester.army/docs/reference/mobile)

Confirmed:

- The `device` fixture covers network, permissions, appearance, location,
  biometrics, keychain, `installApp`, `openApp`, `openLink`, and `fold`.
  Every device setting is simulator-only on a physical iPhone.
- Physical phones are named by device name, not UDID.
- Known iOS limits: `doubleTap` uses about 285 ms between taps;
  `foregroundApp` is stale after `home`.

Inference: Cubby's patched agent-device (SwiftUI toolbar occlusion and input
rebinding) stays necessary until upstream ships those fixes. Check upstream
before upgrading `@e2e-dev/mobile`, which is two minor versions behind.

### Debugging, reporters, telemetry, and `e2e/runner`

[Debugging](https://e2e.tester.army/docs/debugging) ·
[Reporters](https://e2e.tester.army/docs/reference/reporters) ·
[Telemetry](https://e2e.tester.army/docs/telemetry) ·
[e2e/runner](https://e2e.tester.army/docs/reference/runner)

Confirmed:

- Exit codes are 1 (test), 2 (config or policy), 3 (engine, provider, or
  artifact), 4 (internal), and 130 (interrupt).
- Each failure writes `trace.md` with steps, cache decisions, the app log,
  and the screen. `report.json` is versioned.
- `--ai-trace` writes a local file only.
- `video` modes include `on-first-retry`. Videos are unmasked.
- `artifacts.store.put/putLink` receives every artifact, and a failure there
  never fails the run.
- Reporter events stream through `onEvent`. `renderMarkdownReport` is
  exported.
- Telemetry goes to `eu.i.posthog.com`. `E2E_TELEMETRY_DEBUG=1` prints
  payloads and sends nothing.
- `list()` from `e2e/runner` selects tests without starting a run.

Recommendation: Cubby's sanitized bundle already copies only a validated
summary. Add `markdown` as a local-only reporter. An `artifacts.store` would
bypass that sanitization, so don't add one. `e2e/runner list()` could
validate `--journey` selection without booting the harness.

### Migrations and reference

[From Playwright](https://e2e.tester.army/docs/migrate/playwright) ·
[Cypress](https://e2e.tester.army/docs/migrate/cypress) ·
[Selenium](https://e2e.tester.army/docs/migrate/selenium) ·
[Detox](https://e2e.tester.army/docs/migrate/detox) ·
[Maestro](https://e2e.tester.army/docs/migrate/maestro) ·
[Config](https://e2e.tester.army/docs/reference/config) ·
[CLI](https://e2e.tester.army/docs/reference/cli) ·
[Errors](https://e2e.tester.army/docs/reference/errors) ·
[Environment](https://e2e.tester.army/docs/reference/environment) ·
[Example projects](https://e2e.tester.army/docs/example-projects)

Confirmed:

- Playwright and e2e can run side by side, migrating one file at a time.
- Deliberate differences from Playwright: string names match exactly and
  case-sensitively, and text reads use `innerText`.
- `retries` defaults to 1 in CI and 0 locally. `workers` defaults to 1 in CI
  and half the cores locally.
- `--repeat-each`, `--last-failed`, and `--max-failures` are available.

Inference: Cubby's deterministic Playwright suite is the merge gate.
Migrating it isn't indicated.

## Caching and CI feature summary

- **Caching** ([Caching](https://e2e.tester.army/docs/cache)): confirmed
  modes are `read-write` locally, `read-only` in CI when unset, and `off`.
  A step records only after a later check verifies it. `--strict-cache` is
  available, and a custom `cache.store` doesn't default to read-only.
- **CI** ([CI](https://e2e.tester.army/docs/ci),
  [GitHub Actions](https://e2e.tester.army/docs/ci/github-actions),
  [PR comments](https://e2e.tester.army/docs/github)): sharding,
  `--max-failures`, API keys rather than OAuth, and the `@e2e-dev/github`
  reporter. EAS, Bitrise, and Codemagic each have a recipe.

## Gaps and limitations

- This note relies on the docs. Nothing here was run, so feature behavior on
  0.19 against Cubby is unverified.
- Some content is interactive (`<ModelProvider>` provider lists, videos)
  and has no Markdown text, so it wasn't read.
- The reference pages (`expect`, `screen`, `test`, `config`, `cli`,
  `errors`) were sampled for the catalog, not audited line by line.
- The changelogs and releases between 0.16 and 0.19 weren't reviewed, so
  breaking changes for an upgrade are unknown.
- Kernel pricing and direct TypeSafe Jev pricing were checked in the follow-up
  below. EAS has no verified free simulator allowance in the sources examined;
  account access, gateway billing and other model-plan prices were not checked.

## Cost direction agreed in follow-up

The user excludes paid hosted simulators/browsers and wants more Jev in E2E.
This changes the evaluation priority; no provider or dependency was changed.

- **Kernel: skip.** Its $0/month plan includes $5/month of credits, then
  browser usage is metered. A free allowance is not unlimited free CI.
  [Kernel pricing](https://www.kernel.sh/pricing).
- **EAS Simulators: skip.** The inspected Expo pricing/billing pages did not
  establish a free simulator allowance. Do not add it on an assumption of free
  use. This is an unverified free tier, not a claim that every session is paid.
  [Expo pricing](https://expo.dev/pricing),
  [Tester Army EAS integration](https://e2e.tester.army/docs/integrations/eas).
- **Local browsers, local iOS Simulator: retain.** No added hosted-device
  service bill. Existing computer and CI runner costs still apply. smol is a
  local VM option rather than a hosted service; defer it until it solves a
  measured isolation/setup problem.

**Jev economics (confirmed):** TypeSafe publishes $0.042 per million input
tokens and no output-token charge. A hypothetical 10,000-token request costs
$0.00042; 1,000 such requests cost $0.42. These figures are direct TypeSafe
pricing and arithmetic, not a measured Cubby bill or a verified gateway price.
Jev is text-only and selects typed decisions; it does not write arbitrary text.
[TypeSafe model pricing and modalities](https://docs.typesafe.ai/models).

**Recommended division of work (inference):** use Jev for choosing the next
operation and semantic UI element, a small text model for values to type and
structured screen extraction, and deterministic locators/SQL for correctness.
Tester Army's decision executor performs operation and target decisions per
action, plus completion checks; text generation adds a separate cost. Jev
cannot replace screenshot reasoning. Keep visual checks deterministic where
possible and use a vision-capable agent only for a specifically needed flow.
[Decision executor](https://e2e.tester.army/docs/decision-models).

This is likely cheaper for billed cold/live UI decisions than the current
larger generative driver, but the relevant number is cost per correctly
completed journey, including all decisions, text calls, failed attempts and
fallbacks. Cached actions and deterministic assertions already make no model
call; Jev cannot reduce those costs below zero. The local ChatGPT subscription
path has no per-call API charge, so fewer tokens need not reduce the current
subscription bill. No percentage saving or latency improvement is established.

**First pilot:** upgrade the required SDK dependencies, then compare the same
three standard journeys under the current driver and Jev plus a small text
model. Keep fresh synthetic state, exact read-backs and zero retries. Record
success/failure, total billed usage, per-provider requests, time, and replay
hits separately. Use a recorded/pinned Jev version when evaluating thresholds.
Do not increase the live-import application's Jev usage merely to change the
UI driver; those are separate model boundaries.

Cubby's current Tester Army model adapter accepts ChatGPT or OpenAI Responses
models and its preflight requires an image plus tool call. Jev needs a distinct
executor/provider configuration and capability-appropriate preflight, not
`TESTER_ARMY_MODEL=jev`. The current decision executor requires e2e 0.19 and
AI SDK 7.0.134-compatible dependencies. Preserve the mobile driver patches in
any upgrade. This assessment authorizes no benchmark outcome claim.

## CI speed and migration assessment

Recommendation (inference): expand Tester Army selectively; do not replace the
required Playwright suite on the expectation that another runner is faster.
Tester Army's web engine itself uses Playwright. Deterministic e2e tests need
no model, but agent-driven cold steps, handoffs and judgments add model work.
[Introduction](https://e2e.tester.army/docs),
[migration map](https://e2e.tester.army/docs/migrate/playwright).

### Current Cubby implementation, checked in this checkout

- The required desktop lane runs two Playwright shards with two workers each,
  zero retries and fully parallel tests. Each worker owns a database, object
  storage and Worker runtime. Global setup creates the database template.
  Sources: [workflow](../../.github/workflows/ci.yaml),
  [config](../../apps/web/playwright.config.ts),
  [fixtures](../../apps/web/tests/e2e/e2e-test.ts).
- Tester Army is already installed: `e2e` 0.16.0, web engine 0.11.2 and mobile
  engine 0.9.1. Its shared catalog contains 30 journey declarations: 26 standard
  and four coupled live-import journeys. Web and iOS are manual lanes; live
  imports are also scheduled weekly. They are outside the required merge gate.
  Sources: [dependencies](../../apps/web/package.json),
  [catalog](../../apps/web/tooling/tester-army/journeys.ts), workflow above.
  The trial doc's prose still describes three coupled journeys; the current
  catalog and workflow are the evidence for the fourth.
- The trial explicitly uses one worker, zero retries and caching off unless
  `--replay` is requested. Every journey waits 20 seconds in a `finally` block
  because gateway bursts have hit rate limits. At current defaults, the 26
  standard web journeys impose **8m40s of pacing alone**, before setup and UI
  work. This is a configuration-derived floor, not a measured run duration or
  an equal-coverage comparison with Playwright. Raising workers alone would
  not parallelize this catalog: all web journeys are registered in one file.
  Sources: [trial config](../../apps/web/e2e.config.ts),
  [execution](../../apps/web/tooling/tester-army/journey-run.ts),
  [test registration](../../apps/web/tests/tester-army/web-journeys.e2e.ts).
- Agent navigation already ends in deterministic visible checks and exact
  SQL read-backs. Dense screens use structured extraction compared to a seeded
  expectation. Fresh shortcodes are passed through `unique()` for replay.
  Credential registration, telemetry disabling, sanitized evidence bundles and
  exact source/build provenance already exist. Sources:
  [journey contracts](../../apps/web/tooling/tester-army/journey.ts),
  [runner](../../apps/web/tooling/tester-army/runner.ts),
  [owning trial doc](../tester-army.md).

### Fresh CI evidence

The following completed green runs were read through `gh run view` during this
research. They are observations on different revisions, not a controlled
framework benchmark. Durations exclude runner queue time and cover the job from
`startedAt` to `completedAt`.

| Run                                                                           | Desktop 1/2 | Desktop 2/2 | PostgreSQL | Worker build/runtime tests |
| ----------------------------------------------------------------------------- | ----------- | ----------- | ---------- | -------------------------- |
| [PR sample](https://github.com/nickysemenza/cubby/actions/runs/37884151913)   | 7m12s       | 6m44s       | 5m12s      | 3m56s                      |
| [Main sample](https://github.com/nickysemenza/cubby/actions/runs/38019091367) | 5m52s       | 6m50s       | 6m11s      | 5m59s                      |

The main sample ran revision `5dc533b0fa4c4b37678a6f22d5ce5440d01a99f7`.
Its Playwright command steps took 4m14s and 5m11s; those steps include harness
startup and teardown, not only browser actions. Worker compilation in each
desktop job took 29 seconds and browser-cache restore took 4-5 seconds.

Inference: browser installation and compilation are not the dominant cost in
this warm sample. PostgreSQL and Worker/runtime jobs also constrain the required
gate, so even eliminating browser time would not eliminate the remaining jobs.
The older sample does not establish stable shard imbalance. No Tester Army
timing sample with matched coverage was run or retrieved here.

### Features that could improve the loop

**Verified replay cache: first experiment.** Record action steps locally and
share reviewed synthetic entries with CI using committed entries or a trusted
cache restore. `agent.act` replay avoids model calls; `assert`, `waitFor` and
`extract` stay live. Cubby's SQL comparisons and plain-value extraction checks
do not confirm cache recordings: use an explicit locator assertion of the
step's visible outcome as well. Retain the exact persisted-state assertion.
`unique()` handles fresh identifiers and stable app identities already exist.
Source: [caching](https://e2e.tester.army/docs/cache).

**Strict replay: useful drift signal, not an offline guarantee.** Strict mode
fails stale recordings without repairing them live, but new/edited steps,
gaps and truncated entries may still run live. Model judgments also remain live.
For a genuinely model-free required lane, use deterministic actions/assertions
or additionally establish complete replay coverage and fail if a live call is
attempted. The installed 0.16.0 declarations and CLI include `cache.strict`,
`--strict-cache` and `REPLAY_STALE`; this is locally verified availability,
not a tested reliability claim. Source: caching page above and installed
`apps/web/node_modules/e2e/dist/types.d.ts` / `dist/cli/index.js`.

**Native/web reuse: maintenance opportunity.** Preserve Cubby's shared catalog
and exact SQL outcomes while extending a few valuable UI flows across web/iOS.
This may reduce duplicated authoring; it does not remove app compilation,
simulator preparation, database setup or agent-device limitations.
Sources: [mobile](https://e2e.tester.army/docs/mobile), trial doc above.

**Sharding, workers and failure controls: mostly parity.** Tester Army supports
shards, worker counts, tags, last-failed, repeat-each and max-failures. Its CI
defaults are one worker and one retry, so preserve Cubby's explicit zero-retry
policy. Parallelization requires independent files and fixture ownership; no
report merge is currently implemented. Source:
[CI](https://e2e.tester.army/docs/ci).

### Concrete migration costs

The official migration map lists no worker-scoped/option fixtures, no
`globalSetup`/`globalTeardown`, and no within-file `fullyParallel`. Cubby's
Playwright harness uses all three. Porting requires deliberate runtime ownership
and cleanup, with initialization kept outside the runner or adapted to its
per-file hooks. Otherwise repeated provisioning or accidental shared state could
erase any saving. The e2e custom-fixture setup is eager, unlike Playwright's
on-demand fixture setup. This is a contract change, not an import rename.
Source: [migration map](https://e2e.tester.army/docs/migrate/playwright).

Other relevant gaps: no full browser device presets (`isMobile`, touch and
device scale), no equivalent raw `Page` fixture, no normal HTML report, and no
Playwright-style `test.info().attach()` or metadata. Node `fetch` replaces the
request fixture; its authentication/cookie handling needs explicit adaptation.
Keep browser-native regressions requiring these APIs in Playwright until an
equally strong replacement exists. A phone-width viewport alone does not
preserve Cubby's Mobile Safari device emulation. Source: migration map above.

### Proposed bounded evaluation

1. Use three existing standard journeys covering edit/save/reload, a money
   operation with exact cents, and phone-width navigation. First make an
   explicit coverage map to the retained Playwright regressions.
2. Measure cold/live, warm/replay and deterministic Playwright versions on the
   same revision and fixture scope. Include a deliberately wrong persisted
   result and stale replay so a faster pass cannot conceal a regression.
3. Use Cubby's existing acceptance bar: three fresh-state passes with zero
   retries per engine, a failing wrong expectation and a replay comparison.
   This is the documented minimum, not proof of low long-term flake rates.
4. Record queue, build, provisioning, driver preparation, scenario and cleanup
   time separately; compare whole required-gate elapsed time, model calls,
   replay/handoff counts and maintenance effort. Any pacing/concurrency change
   needs separate rate-limit and isolation evidence.
5. Expand only the proven flows. Keep the deterministic exact-head gate while
   exploratory and live-import checks remain opt-in/scheduled. A future gate
   change must update [validation policy](../agents/validation.md) and preserve
   named regressions before deleting old tests.

The initial research assessment changed no runtime behavior. Implementation and
live validation followed it; their current results and remaining acceptance
limits are recorded in the upgrade follow-up above and its owning validation doc.
