# Local check and calendar performance

Measured September 7, 2026 on ARM macOS with TypeScript 7.0.2. These are local
diagnostics, not a comparison with hosted x86 CI.

## Typechecking

The web typecheck now uses `--checkers 1`. The native compiler otherwise checks
the program with multiple independent type graphs. A single checker reduces
duplicate generic instantiations without excluding files or changing diagnostics.
Incremental checking remains enabled; the service-worker check is unchanged.

Representative cold runs (`--noEmit --incremental false --extendedDiagnostics`,
wrapped with `/usr/bin/time -l`):

| Setting | Files | Instantiations | Wall time | CPU user time | Peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Default checkers | 7,403 | 21,307,057 | 12.29 s | 50.44 s | 5.93 GB |
| One checker | 7,403 | 10,148,693 | 12.37 s | 21.52 s | 3.07 GB |

This is primarily a memory and CPU improvement, not a demonstrated latency win.
Earlier measurements overlapped trace generation or dependency installation and
are excluded. Two checkers used about 4.03 GB in an exploratory run. A compiler
trace identified a costly literal-union expression in the entity inspector, but
a local annotation did not show a reliable overall improvement and was removed.

The complete warm `pnpm check` baseline took 7.17–7.51 seconds over three runs
(median 7.21 seconds). Revised warm runs took 7.27–10.20 seconds (median
8.11 seconds), about 12% slower at the median in this small sample. Reducing
compiler memory does not eliminate time spent in lint, Knip, and other repository
guards. The first check after changing compiler settings rebuilds its
incremental state and is not a warm measurement.

A single September 14, 2026 run of `pnpm --dir apps/web exec tsc --noEmit
--incremental false --extendedDiagnostics 2>&1 | head -40` (14.345 s total,
5,785,965K peak) printed no line naming a checker count, so the "Default
checkers" row above stays unlabeled with an actual number rather than a guess.

## Calendar tests and generation

ICS line folding previously allocated a UTF-8 byte array for every character.
An oversized-document test exercised millions of these allocations and timed
out in the hosted pilot. Folding now computes each Unicode code point's byte
width without those allocations. Line limits, continuation spaces, surrogate
handling, and rendered text are preserved.

The existing snapshot and ICS test files took 927 ms of test execution before
the change and 119 ms afterward, including five additional folding cases for
ASCII, two-byte, three-byte, supplementary, and unpaired-surrogate text. End-to-end
test-command duration fell from 3.02 to 2.12 seconds. All 27 tests passed.

## Complete local verification

After the local-verification workflow change, `pnpm verify:local:full` passed
in **124.47 seconds** on the 8-core, 24 GiB ARM Mac, measured with
`/usr/bin/time -p`. This warm run includes WASM preparation, frozen dependency
installation, all repository checks, dependency deduplication, Rust formatting,
Clippy and tests, all Worker builds, workspace tests, PostgreSQL and Playwright.
The PostgreSQL and browser tiers overlap through the existing npm runner after
the fast tier; neither test coverage nor browser worker limits changed.

The preceding full pre-push gate and push took 289.37 seconds, including
52.95 seconds of Clippy compilation and 82 seconds of Rust test compilation.
Warm Clippy and Rust test build phases took 0.15 and 0.19 seconds respectively.
Warm web tests passed all 3,442 cases in 18.87 seconds; PostgreSQL passed all
262 cases in 29.07 seconds, alongside all 22 passing browser tests. Both complete
runs passed. Measurements were taken on code commit `7f7f2c13d` using local Node
26.7.0; hosted configuration continues to pin Node 24. These are two observations
with different cache states, not a controlled before/after comparison or a
measurement of aggregate process-tree memory. The typechecker RSS measurements
above remain separate.

## Excluded claims

Changing Rust test/Clippy order was explored but not retained locally. The
three-second Clippy result reused earlier Clippy output and was not a valid cold
comparison. No tests, required checks, production APIs, or schemas were removed
or weakened to obtain these results.

## Declarative local tooling

This section records the earlier hook and Nx rollout. Current commits use
staged-file lint/format checks and pushes run no validation; see the
[validation policy](agents/validation.md). Measurements below remain historical.

`project.json` replaces the custom check runner, and `scripts/ci-scope.ts`
(the hand-rolled path classifier `verify:local`/`verify:push` used to route
through) is deleted: gates now live as Nx targets on the project whose files
they cover — `apps/web/project.json` (`postgres`, `build-cf`, `e2e`,
`workers-tests`), `recipebridge/project.json` and `cubby-ffi/project.json`
(`rust`), `apps/apple/project.json` (`apple-check`), root `project.json`'s
`cubby-checks` project (`generate`, `types`, `lint`, `format`, `knip`, plus the
uncached `bindings`/`openapi`/`script-tests`/`security`). `nx affected` (used
by `verify:push`) and `nx run-many --projects=… --affected` compute scope from
each target's declared `inputs` against `nx.json`'s `defaultBase`
(`origin/main`) instead of a hand-maintained path-prefix table, so a new
directory needs a project (and target inputs), not an edit to a classifier.

Nx runs four tasks concurrently (`nx.json` `"parallel": 4`); `NX_PARALLEL`
overrides that limit. Existing package scripts and mandatory Git hooks remain
the entrypoints. Nx Cloud and analytics are disabled; the shared local task
cache has a 4 GB limit (`"maxCacheSize": "4GB"`) with built-in eviction. Set
`NX_SKIP_NX_CACHE=true` for a fresh run (`pnpm verify:local:full` always does).
Workspace typechecking also caps package concurrency at two.

Two named inputs replace the single whole-tree `default` this repo used to
hash everything against: `default` (`{projectRoot}/**/*` plus `sharedGlobals`
— the lockfile, `pnpm-workspace.yaml`, `tsconfig.json`, `nx.json`, Node/platform
and select env vars) scopes a project-level target to its own directory, and
`repo` (the whole tree, excluding `apps/apple/**`, `cubby-ffi/**`, `**/*.md`,
`.claude/**`) is what the genuinely whole-tree `cubby-checks`
gates (`generate`, `types`, `lint`, `format`, `knip`) hash instead. Every aux
package under `apps/*`/`packages/*` with a `test` script gets a `nx:run-script`-
inferred `test` target that a repo-wide `targetDefaults` entry makes cached with
`{projectRoot}` inputs; root `pnpm test` (the `fast-tests` target) now runs
`nx run-many -t test` so those aux tests replay from cache on a web-only
change instead of running via `pnpm -r --workspace-concurrency=2 test`, which
had every aux package's Vitest process competing with the (uncached, heavier)
web run for the same CPU budget. The `fast-tests` orchestration target is
uncached and always asks Nx to evaluate every child target; the child targets
own their narrower cache keys, so an outer replay cannot bypass corrected
inputs. Successful and cached tasks collapse to one output line, avoiding a
large stale-log replay in agent context.
`packages/wasm` does not appear in `nx show projects`: its entire directory is
`.gitignore`d (`packages/wasm/.gitignore` is `*`, since its contents —
including `package.json` — are `wasm-pack` build output), and Nx's project
crawl is git-aware, so it never sees that `package.json`. Its generation stays
on the root `wasm` target (keyed off `recipebridge/**`), and it has no
`scripts` of its own, so there is nothing to gain by un-ignoring it.

Cached checks hash the workspace source/configuration, lockfile, patches,
Node/platform, and Node options. Typechecks additionally hash generated WASM
declarations. Fast tests additionally hash ignored WASM/environment files and
test-specific environment settings. MCP App bundles and an empty
failure-summary file are restored, so an older failed run cannot leave a stale
failure list after a successful cache hit. Git-index-sensitive soft-delete
checks, Knip, network audit, tooling tests, bindings/OpenAPI, PostgreSQL, browser
acceptance, and Git-aware verification remain live.

`scripts/cache-gc.ts` (and its test) is deleted along with `ci-scope.ts`;
what it did is now plain commands: `nx reset` clears the Nx daemon/workspace
cache; `cargo sweep -r ~/.cache/cubby/recipebridge-target` and
`cargo sweep -r ~/.cache/cubby/cubby-ffi-target` cap the two shared Rust
target directories (install `cargo-sweep` first: `cargo install cargo-sweep`);
`rm -rf apps/apple/DerivedData` clears native Apple build output. There is no
report-only mode to replace — run `du -sh ~/.cache/cubby/*` directly when you
want the same "what's using space" numbers `cache-gc.ts`'s default (flagless)
invocation printed.

Deleted: `run-checks.ts` (192 lines), `run-checks.test.ts` (111), and
`setup-agent-environment.ts` (49). Required-gate assertions move into the existing
configuration tests. Total `scripts/` lines fall from 12,955 to 12,692; the two
Nx configurations add 137 lines, for a net reduction of 126 lines across those
files. No new custom tooling scripts were added.

Setup uses `pnpm install --frozen-lockfile && node scripts/ensure-wasm.ts`.
Claude's startup condition was exercised against a main checkout (skips setup)
and a linked worktree (invokes setup).

Use external measurement tools:

```sh
hyperfine --warmup 1 --runs 10 'pnpm check'
hyperfine --warmup 1 --runs 10 'NX_SKIP_NX_CACHE=true pnpm check'
```

A lint-cache probe passed, failed after adding a debugger statement, then reused
the successful result after source restoration in 2.27 seconds. The first run
took 42.09 seconds under contention; these are not idle-machine guarantees.
Node 26.7.0 was used locally; `.nvmrc` still requests Node 24.

### Shared dependency-store experiment: not adopted

Disposable checkouts of the pre-change revision used the same lockfile, without
household environment files. Warm-store pnpm 10.34.1 trials took 36.74/60.04
seconds with isolated virtual stores and 74.99/103.67 seconds with the global
layout. Other local jobs were compiling throughout these measurements.

This matches [pnpm #11112](https://github.com/pnpm/pnpm/issues/11112), where fresh
projects reimport populated global entries. pnpm 11.22.0 with the existing
resolution/build policy took 357.16 seconds to populate its separate store,
then 10.66 seconds for a fresh install. Its checkout-local dependency links
reported 1.8 MB versus about 1.4 GB for the isolated layout. These `du` totals
exclude the shared store and do not measure physically reclaimed APFS blocks.
Concurrent minimal projects correctly resolved distinct Zod 3 and 4 versions.

The application validation rejected adoption: the global layout exposed an
undeclared Vitest peer in jest-dom and lost React declaration resolution in
Lucide/chart libraries. A narrow Vitest peer extension fixed the UI import, but
TypeScript's `typeRoots` did not fix the React declarations. `preserveSymlinks`
was also rejected: a negative type probe accepted an invalid chart-axis property,
showing that seemingly improved compilation would weaken checking. This matches
the class of failures in [pnpm #9739](https://github.com/pnpm/pnpm/issues/9739).
All experimental dependency and compiler adjustments were reverted.

That experiment retained pnpm 10 and its existing layout. The follow-up below
addresses the missing type dependencies through package metadata rather than
compiler workarounds. These original measurements remain historical; they did
not demonstrate dependency disk savings or justify a Bun migration.

### Retained patch validation (2026-09-07)

Code revision: `78376ae04819dc7e8cc58deb7b6abeb283bfdbf9`.
Measurements were taken on the same busy ARM Mac and are observations, not a
controlled speedup claim. Cold Cargo compilation is excluded from the setup
comparison, as requested.

| Measurement | Observed result |
| --- | --- |
| Original runner, initial `pnpm check` sample | 181.26 s |
| Retained `pnpm check:all`, uncached | 253.59 s; all 12 gates passed |
| Retained warm `pnpm check` | 13.83 s overall; 6/8 tasks cached |
| Mandatory pre-commit check | Passed; Nx task duration 3.9 s |
| Fresh worktree `pnpm agent:setup` | 67.72 s, including 45.8 s install and 16.22 s WASM preparation |
| Existing worktree `pnpm agent:setup` | 17.00 s; tracked files remained clean |
| Lint cache reused by a separate worktree | 1/1 cache hit; Nx task duration 397 ms |

The full and fast check commands have different gate sets; do not compare their
elapsed times as equivalent workloads. The warm six-second target was missed.
No successful full-fast-test cache timing was recorded because the aggregate
suite encountered timeouts. All disposable benchmark worktrees were removed.

`pnpm verify:local:full` passed frozen installation, WASM preparation,
`check:all`, deduplication, Rust formatting/Clippy, 251 Rust tests (one existing
ignored doctest), and all three Worker builds. It then failed on three
five-second UI test timeouts: date-picker selection, collection-matrix paging,
and workspace navigation. The aggregate web result was 3,439 passed / 3 failed.
All 18 tests across those three files passed in a targeted rerun. An earlier
aggregate run had one MCP catalog-schema timeout; all five tests in that file
also passed alone. No assertion or timeout was relaxed.

The remaining acceptance tiers were run separately: all 262 PostgreSQL tests
passed, and the browser command with the required 22-test count exited
successfully. The full verifier is **not green**; targeted successes do not
replace its failed aggregate result. Failed Nx tasks returned nonzero and were
not cached. A separate hook probe verified that pre-commit propagates a failing
`pnpm check` exit status.


## Worktree setup follow-up (September 7, 2026)

The failed setup was a separate correctness problem: a global Cargo path patch
selected an ingredient-parser checkout older than Cubby's required API. Pulling
that checkout resolved the Rust imports; changing the installer would not have
fixed those missing APIs.

The subsequent successful setup log contained 72.9 seconds of pnpm installation
and 122 seconds of WASM work. Cargo's 87-second portion included an artifact-lock
wait. There were no crate-compilation messages in that run. The remaining roughly
35 seconds includes binding-tool preparation, binding generation, optimization,
and packaging; it is not a measurement of wasm-opt alone.

### Measured causes

- pnpm 10's global content store avoided downloads, but every checkout recreated
  an isolated virtual store. The inspected checkout contained 105,398 files,
  18,618 directories and 4,783 symlinks. An instrumented install found cached
  packages within 2.7 seconds but took 41.6 seconds overall, mostly importing files
  with APFS clones. Separate hard-link and clone trials took 68.9 and 68.8 seconds;
  hard linking increased system CPU and was not adopted.
- A warm Cargo compile took 0.66 seconds, while the full wasm-pack command took
  28.1 seconds. Its finished JS/declaration/WASM package was not shared between
  worktrees, so every fresh checkout repeated the binding and optimization work.
- Direct lint and format checks bypassed the existing Nx targets. A deliberately
  invalid TypeScript file correctly invalidated the new lint cache and failed.
  An independent bounded lint profile found about 0.5–0.6 seconds of fixed JS
  plugin/AST bridge overhead, with essentially no change when all custom rules
  were disabled. Changing rule implementations or thread counts was not justified.
- Warm Knip took 5.2 seconds: file discovery, dependency reconciliation and cache
  loading dominated; parsing was already cached. It remains live.

The machine ran other worktrees, Rust builds, desktop apps and Time Machine
throughout parts of this investigation. Its one-minute load exceeded 200 and
swap usage reached about 6.8 GiB. These observations are not idle-machine
speed guarantees or controlled before/after comparisons. All executed Node
commands reported 26.7.0, including the local binary at the node@24 Homebrew path;
that path's name is not evidence of Node 24 validation.

### Retained implementation

pnpm 12.3.4 uses a local virtual store so package peer resolution remains rooted in
each workspace package. This is slightly less aggressive about sharing completed
dependency graphs across fresh worktrees, but avoids global-store symlink resolution
issues in CLI tools such as Drizzle Kit.
`allowBuilds` preserves the two approved build scripts; `strictDepBuilds: false`
preserves the previous warning-only treatment of unapproved scripts. Explicit
`minimumReleaseAge: 0` preserves the previous dependency-update policy.

The maintained `@pnpm/plugin-types-fixer` config dependency repairs published
packages' missing type dependencies. Packages that omit their
monorepo devDependencies from their published metadata have explicit optional
React type peers; jest-dom declares its Vitest peer. Nivo line also needs its
undeclared runtime Lodash dependency supplied explicitly, and vite-ssr-components
needs its Vite peer declared for the UPC build. No compiler flags, application
types, test assertions or global-store symlinks are weakened to make this work.
Both a valid web/service-worker typecheck and negative Nivo-axis/Lucide-event
probes were exercised in the exploratory global-store checkout.

Nx now stores the complete WASM package. The existing ensure-wasm entrypoint
supplies resolved Cargo metadata, local source/asset contents, Cargo configuration,
tool versions and build environment as a content fingerprint. Normalization occurs
before sorting local source roots. Metadata failure fails closed. The tracked
WASM package manifest and ignore file are also inputs because cache restoration
writes them. Deleting the generated binary in a separate checkout and restoring
it produced identical binary bytes; that cache-hit command took 0.83 seconds.

Read-only `lint` and `format:check` reuse the same Nx targets as `check`; their
inputs exclude Markdown, Rust, TOML and lock files that those tools do not inspect.
The YAML pnpm lockfile remains an input. Editing commands still always execute.
No new custom tooling script was added. Nx owns artifact storage and eviction.
The WASM target explicitly excludes Nx's implicit all-JavaScript-dependencies
input: its assembled graph differs across installs but cannot change the raw
Rust build. The root package script, Rust fingerprint and tool versions remain
inputs. A real cross-checkout restore after deleting the destination binary
passed with identical SHA-256 bytes in 8.37 seconds under concurrent load.

### Validation results

An exploratory fresh checkout completed setup in 8.94 seconds with no downloads;
a repeat setup completed in 4.83 seconds. With the final configuration, a new
checkout completed in 34.05 seconds while host load exceeded 200: the initial
pnpm graph linking took 12.7 seconds, the explicit frozen install 3 seconds, and
Nx reported a verified WASM cache hit (7.3 seconds including hashing). It did not
compile or optimize WASM. The paired root pnpm invocation also hit (22.41 seconds
overall). These final measurements include much more contention than the earlier
single-digit-second runs; they are not a sub-five-second end-to-end guarantee. The final ordinary `pnpm check` passed with six
cache hits in 2.7 seconds. These runs had different host load, so the timings are
observations rather than fixed latency promises.

The fast suite passed, including all 498 web files / 3,477 web tests. All 54
orchestration tests ran: 53 passed, including the affected WASM/cache tests;
the pre-existing contract-manifest guard expects 58 files while HEAD contains 59.
Commit `22ce652e7` added the cookbook-photo contract without updating that count.
`check:all` passed its other gates, including bindings, OpenAPI and security.
The final production web build, dependency deduplication and regular `check`
also passed after supplying Nivo's missing runtime dependency. PostgreSQL passed
all 268 tests across eight families, but its reporter failed the unchanged
expected count of 265. The same baseline commit added the three extra cases;
PR preparation updates those counts to match the existing cases.
The committed-revision verifier refuses uncommitted changes; its underlying
checks were exercised directly while this proposal remains uncommitted. USDA and
UPC production builds passed. Cargo formatting and Clippy passed; Rust tests
passed 246 cases with one ignored doctest. Knip excludes the root-only Vitest/Vite dependency findings produced by
package-extension peers; application workspace dependency checks remain enabled.

The browser run passed 23 cases and had one initialization failure caused by this
repair's concurrent WASM rebuild temporarily removing the source package. The
isolated iPhone WebKit calendar case passed once setup activity stopped. The full
run is therefore not reported as a green authoritative run. Its 24 discovered
cases also exceed the current configured count of 23. No browser assertions were changed. PR preparation updates the total to 24
and the Chromium lane to 17, retaining seven WebKit cases.

The final `pnpm check` passed all eight targets in 57.7 seconds after the final
configuration changes invalidated its caches. The host's one-minute load was
337 at completion. Final `pnpm dedupe:check` and all 12 affected script tests
passed. Temporary benchmark checkouts and their Nx daemon were removed; measured
logs remain under /tmp.

PR preparation refreshed the stale count guards (59 contract files, 268 PostgreSQL
tests, 24 browser tests) so mandatory pre-push validation can run without bypasses.

Merging the subsequent CalDAV change from main adds one contract file and four
PostgreSQL cases; the combined branch retains its calendar Worker tests and uses
60 contract files / 272 PostgreSQL tests.

## Worktree WASM restore (September 14, 2026)

Measured today on this machine (8-core ARM, 24 GB):

| Case | Before | After |
| --- | ---: | ---: |
| Fresh worktree `pnpm agent:setup` WASM step | 54.8 s (Nx miss, full 69-crate build) | 1.6 s (Nx hit restores `packages/wasm`) |
| Warm checkout `node scripts/ensure-wasm.ts` (nothing changed) | ~7 s (verified Nx hit re-hashes and re-copies outputs) | 0.3 s (in-package `.fingerprint` marker matches) |
| Same commit, two checkouts — fingerprint equal? | no (untracked `recipebridge/Cargo.lock` re-resolved per checkout; `.DS_Store`/`.claude/` hashed) | yes |

`recipebridge/Cargo.lock` is now tracked: untracked, it was re-resolved by
cargo metadata on every fresh checkout and rewritten each time, so no two
worktrees ever shared a fingerprint key. `.DS_Store` and `.claude/` are now
pruned from the source digest, since Finder rewrites `.DS_Store` on browse and
that invalidated the cached artifact for nothing. `ensure-wasm.ts` now
short-circuits on an in-package marker the way `ensure-apple-ffi.ts` already
did, which is why a warm, nothing-changed checkout drops from ~7 s to 0.3 s.

## Cross-worktree Xcode caches (September 14, 2026)

Wholesale sharing of `DerivedData` or SwiftPM's `.build` across worktrees is
not worth trying: both key intermediates on absolute source paths, so a second
worktree gets no hits and concurrent builds contend for one build database.
Two path-independent slices were measured instead, each as a cold
`xcodebuild … -scheme Cubby-iOS -destination "generic/platform=iOS Simulator"`
into a fresh `-derivedDataPath`, run sequentially on an otherwise idle 8-core
machine (one populate run, then the measured run):

| Case | Cold build | DerivedData |
| --- | ---: | ---: |
| Baseline | 132 s | 4.5 GB |
| `-clonedSourcePackagesDirPath <shared>` (second worktree) | 177 s | 1.1 GB (+3.5 GB shared) |
| `COMPILATION_CACHE_ENABLE_CACHING=YES` + shared `COMPILATION_CACHE_CAS_PATH` (second worktree) | 121 s | 4.5 GB (+1.0 GB CAS) |

Neither changes build time beyond run-to-run noise (the populate runs were
116 s and 102 s), so neither flag was adopted. The shared clone directory is a
disk-only win — 3.4 GB less `DerivedData` per worktree — and would need a
check that two worktrees resolving packages concurrently serialize on
SwiftPM's lock before it is worth a follow-up.
